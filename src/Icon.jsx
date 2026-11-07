const PATHS = {
  download: "M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14",
  plus: "M12 5v14M5 12h14",
  pause: "M9 5v14M15 5v14",
  play: "M8 5.5v13l10.5-6.5z",
  stop: "M7 7h10v10H7z",
  retry: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5",
  save: "M12 4v10m0 0-4-4m4 4 4-4M5 16v3h14v-3",
  close: "M6 6l12 12M18 6 6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zm0 0v5h5",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z",
  broom: "M14 4l6 6M4 20l7.5-7.5m-1.5-1.5 4 4-2 5-7-7z",
};

export function Icon({ name }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
