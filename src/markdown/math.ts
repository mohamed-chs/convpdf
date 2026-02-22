export interface MathProtectionResult {
  text: string;
  restore: (html: string) => string;
  restoreHtml: (html: string) => string;
}

const findClosingBracket = (input: string, openIndex: number): number => {
  let depth = 0;
  for (let index = openIndex; index < input.length; index++) {
    const char = input[index];
    if (!char) continue;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') {
      depth += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const findClosingParen = (input: string, openIndex: number): number => {
  let depth = 0;
  for (let index = openIndex; index < input.length; index++) {
    const char = input[index];
    if (!char) continue;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const stripMarkdownLinkDestinations = (content: string): string => {
  let output = '';
  let index = 0;

  while (index < content.length) {
    const current = content[index];
    if (!current) break;

    const isImageLink = current === '!' && content[index + 1] === '[';
    const bracketStart = isImageLink ? index + 1 : current === '[' ? index : -1;

    if (bracketStart < 0) {
      output += current;
      index += 1;
      continue;
    }

    if (bracketStart > 0 && content[bracketStart - 1] === '\\') {
      output += current;
      index += 1;
      continue;
    }

    const bracketEnd = findClosingBracket(content, bracketStart);
    if (bracketEnd < 0) {
      output += current;
      index += 1;
      continue;
    }

    let destinationStart = bracketEnd + 1;
    while (/\s/.test(content[destinationStart] ?? '')) {
      destinationStart += 1;
    }

    if (content[destinationStart] !== '(') {
      output += current;
      index += 1;
      continue;
    }

    const destinationEnd = findClosingParen(content, destinationStart);
    if (destinationEnd < 0) {
      output += current;
      index += 1;
      continue;
    }

    output += content.slice(bracketStart + 1, bracketEnd);
    index = destinationEnd + 1;
  }

  return output;
};

const replaceWithPlaceholders = (
  input: string,
  pattern: RegExp,
  keyPrefix: string,
  store: Map<string, string>,
  createId: () => string
): string =>
  input.replace(pattern, (match) => {
    const id = `@@${keyPrefix}_${createId()}@@`;
    store.set(id, match);
    return id;
  });

export const protectMath = (content: string): MathProtectionResult => {
  const codeGuards = new Map<string, string>();
  const mathGuards = new Map<string, string>();
  const escapedDollarGuards = new Map<string, string>();
  let placeholderIndex = 0;
  const createPlaceholderId = (): string => {
    placeholderIndex += 1;
    return `CONVPDF_PLACEHOLDER_${placeholderIndex}`;
  };

  // Fence guards first so we never interpret math inside code blocks.
  let text = replaceWithPlaceholders(
    content,
    /^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?\r?\n\1\2[ \t]*$/gm,
    'CODE_FENCE',
    codeGuards,
    createPlaceholderId
  );

  // Inline code spans can still contain things that look like LaTeX.
  text = replaceWithPlaceholders(
    text,
    /(`+)([^`\n]|`(?!\1))+?\1/g,
    'CODE_SPAN',
    codeGuards,
    createPlaceholderId
  );

  // Display math blocks.
  text = replaceWithPlaceholders(
    text,
    /^\$\$[ \t]*\r?\n[\s\S]*?\r?\n\$\$[ \t]*$/gm,
    'MATH_BLOCK',
    mathGuards,
    createPlaceholderId
  );
  text = replaceWithPlaceholders(
    text,
    /^\\\[[ \t]*\r?\n[\s\S]*?\r?\n\\\][ \t]*$/gm,
    'MATH_BLOCK',
    mathGuards,
    createPlaceholderId
  );
  text = replaceWithPlaceholders(
    text,
    /\$\$[^\n]+?\$\$/g,
    'MATH_INLINE',
    mathGuards,
    createPlaceholderId
  );
  text = replaceWithPlaceholders(
    text,
    /\\\[[^\n]*?\\\]/g,
    'MATH_INLINE',
    mathGuards,
    createPlaceholderId
  );

  // Inline math.
  text = replaceWithPlaceholders(
    text,
    /\\\([^\n]*?\\\)/g,
    'MATH_INLINE',
    mathGuards,
    createPlaceholderId
  );
  text = replaceWithPlaceholders(
    text,
    /(?<!\\)\$(?!\s)([^\n$]|\\\$)+?(?<!\s)(?<!\\)\$/g,
    'MATH_INLINE',
    mathGuards,
    createPlaceholderId
  );

  // Escaped dollars should render as a literal "$", but must never become MathJax delimiters.
  text = replaceWithPlaceholders(
    text,
    /\\\$/g,
    'ESCAPED_DOLLAR',
    escapedDollarGuards,
    createPlaceholderId
  );

  // Restore code guards before lexing markdown.
  for (const [id, code] of codeGuards) {
    text = text.split(id).join(code);
  }

  const restore = (html: string): string => {
    let output = html;
    for (const [id, original] of mathGuards) {
      output = output.split(id).join(original);
    }
    for (const id of escapedDollarGuards.keys()) {
      output = output.split(id).join('$');
    }
    return output;
  };

  const restoreHtml = (html: string): string => {
    let output = html;
    for (const [id, original] of mathGuards) {
      output = output.split(id).join(original);
    }
    for (const id of escapedDollarGuards.keys()) {
      output = output
        .split(id)
        .join('<span class="convpdf-math-ignore" aria-hidden="true">&#36;</span>');
    }
    return output;
  };

  return { text, restore, restoreHtml };
};

export const hasMathSyntax = (content: string): boolean => {
  const sanitized = content
    .replace(/^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?\r?\n\1\2[ \t]*$/gm, '')
    .replace(/(`+)([^`\n]|`(?!\1))+?\1/g, '')
    .replace(/<https?:\/\/[^>\s]+>/gi, '')
    .replace(/<mailto:[^>\s]+>/gi, '');

  const linkStripped = stripMarkdownLinkDestinations(sanitized);

  return /(?<!\\)\$[^$\n]+\$|(?<!\\)\$\$[\s\S]+?\$\$|\\\([^\n]+?\\\)|\\\[[\s\S]+?\\\]/.test(
    linkStripped
  );
};
