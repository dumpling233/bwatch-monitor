import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5173/' });

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`online counts remain aligned at fractional zoom with ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto('/');
    await expect(page.getByTestId('multiview-panel')).toBeVisible();
    await page.route('**/__rolling_number', route => route.fulfill({ contentType: 'text/html', body: `
      <html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
        import React from '/node_modules/.vite/deps/react.js';
        import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
        import { RollingNumber } from '/client/ui.tsx';
        import '/client/modern.css';
        const root = ReactDOM.createRoot(document.getElementById('root'));
        window.setOnline = value => root.render(React.createElement('strong', { style: { fontSize: '13.3px' } },
          React.createElement(RollingNumber, { value })));
        window.setOnline(1234567890);
      </script></body></html>` }));
    await page.goto('/__rolling_number');
    const number = page.locator('.rolling-number');
    const update = (value: number) => page.evaluate(value => (window as unknown as { setOnline: (value: number) => void }).setOnline(value), value);
    const expectAligned = async () => {
      await expect(number.locator('.rolling-number-track')).toHaveCount(0);
      const offsets = await number.evaluate(element => {
        const targets = element.getAttribute('aria-label')!.replace(/\D/g, '');
        return [...element.querySelectorAll('.rolling-number-digit')].map((viewport, index) => {
          const value = viewport.querySelector('.rolling-number-value')!;
          return { matches: value.textContent === targets[index],
            offset: Math.abs(value.getBoundingClientRect().top - viewport.getBoundingClientRect().top) };
        });
      });
      expect(offsets).toHaveLength(10);
      expect(offsets.every(value => value.matches && value.offset <= 0.02)).toBe(true);
    };
    await expect(number).toHaveAttribute('aria-label', '1,234,567,890');
    for (const zoom of [0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
      await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
      await expectAligned();
    }
    await update(9876543210);
    await expect(number).toHaveAttribute('aria-label', '9,876,543,210');
    await update(6789012345);
    await expect(number).toHaveAttribute('aria-label', '6,789,012,345');
    await expectAligned();
    // A cancelled CSS transition must still settle on the latest actual count.
    await page.addStyleTag({ content: '.rolling-number-track { transition: none !important; }' });
    await update(9012345678);
    await expect(number).toHaveAttribute('aria-label', '9,012,345,678');
    await expectAligned();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectAligned();
  });
}
