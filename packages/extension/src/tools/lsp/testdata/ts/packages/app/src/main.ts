import { greet } from "@core";
import { helper } from "../../core/src/util";

export const message = greet("app") + helper();
