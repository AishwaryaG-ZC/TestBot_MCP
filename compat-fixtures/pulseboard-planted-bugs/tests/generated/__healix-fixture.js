import { test as base, expect, request } from '@playwright/test';

const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await page.addInitScript("\n(() => {\n  if (window.__healixCursorOverlayInstalled) return;\n  window.__healixCursorOverlayInstalled = true;\n\n  const ensureCursor = () => {\n    const existing = document.getElementById('__healix-cursor-overlay');\n    if (existing) return existing;\n\n    const dot = document.createElement('div');\n    dot.id = '__healix-cursor-overlay';\n    dot.setAttribute('aria-hidden', 'true');\n    dot.style.cssText = [\n      'position:fixed',\n      'left:0',\n      'top:0',\n      'width:16px',\n      'height:16px',\n      'margin-left:-8px',\n      'margin-top:-8px',\n      'border-radius:9999px',\n      'background:rgba(255,82,82,0.95)',\n      'border:2px solid rgba(255,255,255,0.95)',\n      'box-shadow:0 0 0 1px rgba(0,0,0,0.35)',\n      'z-index:2147483647',\n      'pointer-events:none',\n      'opacity:0',\n      'transform:translate(-100px,-100px)',\n      'transition:opacity 80ms linear, transform 16ms linear'\n    ].join(';');\n    document.documentElement.appendChild(dot);\n    return dot;\n  };\n\n  const move = (event) => {\n    const dot = ensureCursor();\n    dot.style.opacity = '1';\n    dot.style.transform = 'translate(' + event.clientX + 'px,' + event.clientY + 'px)';\n  };\n\n  const hide = () => {\n    const dot = document.getElementById('__healix-cursor-overlay');\n    if (dot) dot.style.opacity = '0';\n  };\n\n  document.addEventListener('mousemove', move, true);\n  document.addEventListener('mouseenter', move, true);\n  document.addEventListener('mouseleave', hide, true);\n})();\n");
    await use(page);
  },
});

export { test, expect, request };
