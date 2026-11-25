// outside every tsconfig: analyzed with default options
import { greet } from "../../core/src/index";

export const rendered = greet("ssr");
