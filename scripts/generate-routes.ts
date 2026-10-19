import { Generator, getConfig } from "@tanstack/router-generator";

const root = process.cwd();
await new Generator({ config: getConfig({}, root), root }).run();
