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
import { watchFocusOrigin } from "./lib.js";
import { applyTheme, readTheme, safeStorage } from "./theme.js";
import { App } from "./ui/App.js";

// Space on a button reached by keyboard presses it; after a click it plays (§19.8).
watchFocusOrigin(document);

// Before the first paint, so a light desk never flashes dark.
applyTheme(readTheme(safeStorage()));

render(<App />, document.getElementById("app")!);
