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
import { watchFocusOrigin } from "./lib.js";
import { App } from "./ui/App.js";

// Space on a button reached by keyboard presses it; after a click it plays (§19.8).
watchFocusOrigin(document);

render(<App />, document.getElementById("app")!);
