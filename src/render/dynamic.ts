import type { Page } from 'puppeteer';

export const waitForDynamicContent = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const waitUntil = async (
      check: () => boolean,
      timeoutMs: number,
      label: string
    ): Promise<void> => {
      const startedAt = Date.now();
      while (!check()) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`${label} did not initialize within ${timeoutMs}ms`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    };

    const images = Array.from(document.querySelectorAll('img'));
    await Promise.all(
      images.map(async (image) => {
        if (image.complete) return;
        await new Promise<void>((resolveImage) => {
          const complete = () => {
            resolveImage();
          };
          image.addEventListener('load', complete, { once: true });
          image.addEventListener('error', complete, { once: true });
          setTimeout(complete, 5000);
        });
      })
    );

    const win = window as Window & {
      MathJax?: {
        startup?: { promise?: Promise<void> };
        typesetPromise?: () => Promise<void>;
      };
      mermaid?: {
        run?: (options?: { querySelector?: string; suppressErrors?: boolean }) => Promise<void>;
      };
    };

    if (document.getElementById('MathJax-script')) {
      await waitUntil(
        () => typeof win.MathJax?.typesetPromise === 'function' || !!win.MathJax?.startup?.promise,
        10000,
        'MathJax'
      );
      if (win.MathJax?.startup?.promise) {
        await win.MathJax.startup.promise;
      }
      // After startup, typesetPromise should be available. Wait for it explicitly
      // so that math is never silently skipped if startup resolved just before typesetPromise
      // was registered.
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

    await new Promise<void>((resolveFrame) => {
      requestAnimationFrame(() => {
        resolveFrame();
      });
    });
  });
};
