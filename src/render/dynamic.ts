import type { Page } from 'puppeteer-core';

const WAIT_FOR_DYNAMIC_CONTENT_SCRIPT = String.raw`
(async () => {
  const waitUntil = async (check, timeoutMs, label) => {
    const startedAt = Date.now();
    while (!check()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(label + ' did not initialize within ' + timeoutMs + 'ms');
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  };

  const images = Array.from(document.querySelectorAll('img'));
  await Promise.all(
    images.map(async (image) => {
      if (image.complete) return;
      await new Promise((resolveImage) => {
        const complete = () => {
          resolveImage();
        };
        image.addEventListener('load', complete, { once: true });
        image.addEventListener('error', complete, { once: true });
        setTimeout(complete, 5000);
      });
    })
  );

  const win = window;

  if (document.getElementById('MathJax-script')) {
    await waitUntil(
      () => typeof win.MathJax?.typesetPromise === 'function' || !!win.MathJax?.startup?.promise,
      10000,
      'MathJax'
    );
    if (win.MathJax?.startup?.promise) {
      await win.MathJax.startup.promise;
    }
    if (typeof win.MathJax?.typesetPromise !== 'function') {
      await waitUntil(
        () => typeof win.MathJax?.typesetPromise === 'function',
        5000,
        'MathJax typesetPromise'
      );
    }
    const mathjax = win.MathJax;
    if (mathjax && typeof mathjax.typesetPromise === 'function') {
      await mathjax.typesetPromise();
    }
  }

  if (document.getElementById('Mermaid-script') && document.querySelector('.mermaid')) {
    await waitUntil(() => typeof win.mermaid?.run === 'function', 10000, 'Mermaid');
    if (document.fonts && 'ready' in document.fonts) {
      await document.fonts.ready;
    }
    await win.mermaid?.run?.({ querySelector: '.mermaid', suppressErrors: false });
  }

  if (document.fonts && 'ready' in document.fonts) {
    await document.fonts.ready;
  }

  await new Promise((resolveFrame) => {
    requestAnimationFrame(() => {
      resolveFrame();
    });
  });
})()
`;

export const waitForDynamicContent = async (page: Page): Promise<void> => {
  await page.evaluate(WAIT_FOR_DYNAMIC_CONTENT_SCRIPT);
};
