import * as esbuild from "esbuild";

const isServe = process.argv.includes("--serve");

const buildOptions = {
  bundle: true,
  entryPoints: ["main.ts"],
  format: "iife",
  logLevel: "info",
  outfile: "dist/main.js",
  platform: "browser",
  sourcemap: true,
  target: ["es2020"]
};

if (isServe) {
  const context = await esbuild.context(buildOptions);
  await context.watch();

  await context.serve({
    servedir: ".",
    port: 3000
  });
} else {
  await esbuild.build(buildOptions);
}
