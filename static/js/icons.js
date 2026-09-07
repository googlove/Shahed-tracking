/*
 * SkyIcons — мінімалістичні, схематичні SVG-силуети (без державної
 * символіки чи реальних розпізнавальних знаків) для кожного типу цілі.
 * Форма й колір розрізняють тип, обертання (--m-heading) показує напрямок,
 * пульсуюче кільце — активність цілі.
 */
const SkyIcons = (() => {

  const COLORS = {
    shahed:     "#D98E3B",
    geran:      "#9C8A46",
    jet_shahed: "#E2622B",
    missile:    "#D93B3B",
    ballistic:  "#B23A6B",
  };

  const LABELS = {
    shahed:     "Shahed-136",
    geran:      "Герань-2",
    jet_shahed: "Реактивний Shahed",
    missile:    "Крилата ракета",
    ballistic:  "Балістична ракета",
  };

  // Всі глюфи в viewBox 0 0 24 24, носом на північ (0°); обертає їх CSS.
  const GLYPHS = {
    shahed: (c) => `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 1 L20.5 21 L12 17 L3.5 21 Z" fill="${c}"/>
        <circle cx="12" cy="13" r="1.5" fill="#0B1215" opacity="0.45"/>
      </svg>`,
    geran: (c) => `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 1 L20.5 21 L12 17 L3.5 21 Z" fill="${c}" stroke="#0B1215" stroke-width="0.6" stroke-dasharray="2 1.3"/>
        <circle cx="12" cy="13" r="1.5" fill="#0B1215" opacity="0.45"/>
      </svg>`,
    jet_shahed: (c) => `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 1 L19.5 19 L12 15.5 L4.5 19 Z" fill="${c}"/>
        <path class="flame" d="M10.2 19 L12 24 L13.8 19 Z" fill="#FFB84D"/>
      </svg>`,
    missile: (c) => `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0 L15 6 L15 16 L9 16 L9 6 Z" fill="${c}"/>
        <path d="M9 13 L5 17.2 L9 16.2 Z" fill="${c}"/>
        <path d="M15 13 L19 17.2 L15 16.2 Z" fill="${c}"/>
        <path class="flame" d="M10 16 L12 23 L14 16 Z" fill="#FF8A4C"/>
      </svg>`,
    ballistic: (c) => `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0 L15.5 7 L15.5 15 L8.5 15 L8.5 7 Z" fill="${c}"/>
        <path d="M8.5 10 L4 15.2 L8.5 13.6 Z" fill="${c}"/>
        <path d="M15.5 10 L20 15.2 L15.5 13.6 Z" fill="${c}"/>
        <path d="M8.5 15 L5.5 19.2 L8.5 17.4 Z" fill="${c}" opacity="0.85"/>
        <path d="M15.5 15 L18.5 19.2 L15.5 17.4 Z" fill="${c}" opacity="0.85"/>
        <path class="flame" d="M9.3 15 L12 24 L14.7 15 Z" fill="#FF6A3D"/>
      </svg>`,
  };

  function color(type){ return COLORS[type] || COLORS.shahed; }
  function label(type){ return LABELS[type] || type; }
  function glyph(type){ return (GLYPHS[type] || GLYPHS.shahed)(color(type)); }

  const FAST_TYPES = new Set(["jet_shahed", "missile", "ballistic"]);

  // HTML для Leaflet divIcon: кільце радара + обертовий гліф.
  function markerHtml(type, headingDeg, status){
    const isActive = !status || status === "active";
    const classes = ["map-marker"];
    if (FAST_TYPES.has(type)) classes.push("is-jet");
    if (!isActive) classes.push("is-downed");
    const deg = Number.isFinite(headingDeg) ? headingDeg : 0;
    return `<div class="${classes.join(" ")}" style="--m-color:${color(type)};--m-heading:${deg}deg;">
      <div class="map-marker__ring"></div>
      <div class="map-marker__glyph">${glyph(type)}</div>
    </div>`;
  }

  return { COLORS, LABELS, color, label, glyph, markerHtml };
})();
