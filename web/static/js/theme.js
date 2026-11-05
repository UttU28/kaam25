// The app's look: Classic (the original), Retro (a phosphor terminal) or Aurora (glass under
// northern lights) - all dark. Loaded in <head> before anything paints, so a page never flashes in
// the wrong theme. The choice is remembered in this browser (Settings > Theme) and follows into
// every open tab of the app.
(function () {
  const storageKey = "kaamTheme";
  const themes = {
    classic: { name: "Classic", icon: "#5b8cff", bar: "#0b0d11", fonts: "" },
    retro: {
      name: "Retro", icon: "#ffb000", bar: "#0a0805",
      fonts: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=VT323&display=swap",
    },
    aurora: {
      name: "Aurora", icon: "#a77bff", bar: "#070912",
      fonts: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap",
    },
  };

  function saved() {
    try { return localStorage.getItem(storageKey) || "classic"; } catch { return "classic"; }
  }

  function apply(name) {
    const key = themes[name] ? name : "classic";
    const theme = themes[key];
    const root = document.documentElement;
    root.dataset.theme = key;
    // the theme's fonts (Classic uses the system ones)
    let fontLink = document.getElementById("themeFonts");
    if (theme.fonts) {
      if (!fontLink) {
        fontLink = document.createElement("link");
        fontLink.id = "themeFonts";
        fontLink.rel = "stylesheet";
        document.head.appendChild(fontLink);
      }
      if (fontLink.href !== theme.fonts) fontLink.href = theme.fonts;
    } else if (fontLink) fontLink.remove();
    // the tab icon (the bolt) and the browser bar take the theme's colour
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='${theme.icon}' d='M13 2 4 14h7l-1 8 9-12h-7z'/></svg>`;
    let iconLink = document.querySelector("link[rel='icon']");
    if (!iconLink) {
      iconLink = document.createElement("link");
      iconLink.rel = "icon";
      document.head.appendChild(iconLink);
    }
    iconLink.href = "data:image/svg+xml," + encodeURIComponent(svg);
    let bar = document.querySelector("meta[name='theme-color']");
    if (!bar) {
      bar = document.createElement("meta");
      bar.name = "theme-color";
      document.head.appendChild(bar);
    }
    bar.content = theme.bar;
    return key;
  }

  window.kaamTheme = {
    list: () => Object.entries(themes).map(([key, t]) => ({ key, name: t.name })),
    get: () => document.documentElement.dataset.theme || "classic",
    set(name) {
      const key = apply(name);
      try { localStorage.setItem(storageKey, key); } catch { /* storage blocked: this visit only */ }
      window.dispatchEvent(new CustomEvent("kaamThemeChange", { detail: key }));
      return key;
    },
  };

  apply(saved());
  // Changed in another tab of the app: follow it here too.
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey) {
      apply(event.newValue || "classic");
      window.dispatchEvent(new CustomEvent("kaamThemeChange", { detail: window.kaamTheme.get() }));
    }
  });
})();
