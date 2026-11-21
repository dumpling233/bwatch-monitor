/** Match the native layout gutter in classic and overlay scrollbar modes. */
export function trackScrollbarGutter() {
  const measure = document.createElement('div');
  const content = document.createElement('div');
  measure.className = 'ui-scrollbar-measure';
  measure.setAttribute('aria-hidden', 'true');
  measure.append(content);
  document.body.append(measure);
  const update = () => {
    const width = measure.offsetWidth - measure.clientWidth;
    document.documentElement.style.setProperty('--ui-scrollbar-gutter', `${width}px`);
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(content);
}
