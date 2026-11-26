import { render } from "preact";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";
import "./changes.css";
import "./cues.css";
import "./desk.css";
import "./agent.css";
import { keepHereKey } from "./here.js";
import { watchFocusOrigin } from "./lib.js";
import { applyTheme, readTheme, safeStorage } from "./theme.js";
import { App } from "./ui/App.js";
import { installTips } from "./tips.js";

// §35.5: a desk Rushes opened itself carries the here key; it is kept for the tab and taken out of the address.
keepHereKey();
window.addEventListener("hashchange", () => keepHereKey());

// Space on a button reached by keyboard presses it; after a click it plays (§19.8).
watchFocusOrigin(document);

// Before the first paint, so a light desk never flashes dark.
applyTheme(readTheme(safeStorage()));

// §37.5: one tooltip layer for every data-tip on the page.
installTips(document);

render(<App />, document.getElementById("app")!);
