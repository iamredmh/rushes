import { render } from "preact";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";
import "./changes.css";
import { watchFocusOrigin } from "./lib.js";
import { App } from "./ui/App.js";

// Space on a button reached by keyboard presses it; after a click it plays (§19.8).
watchFocusOrigin(document);

render(<App />, document.getElementById("app")!);
