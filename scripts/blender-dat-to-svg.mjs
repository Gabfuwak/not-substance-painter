#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    crop: true,
    mixedColorMode: "error",
    precision: 2,
    scale: 100,
  };
  const positional = [];

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    if (arg === "--crop") {
      options.crop = true;
      continue;
    }

    if (arg === "--no-crop") {
      options.crop = false;
      continue;
    }

    if (arg.startsWith("--mixed-color-mode=")) {
      options.mixedColorMode = arg.slice("--mixed-color-mode=".length);
      continue;
    }

    if (arg.startsWith("--precision=")) {
      options.precision = Number.parseInt(arg.slice("--precision=".length), 10);
      continue;
    }

    if (arg.startsWith("--scale=")) {
      options.scale = Number.parseFloat(arg.slice("--scale=".length));
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  if (positional.length < 1 || positional.length > 2) {
    fail(
      "Usage: node scripts/blender-dat-to-svg.mjs <input.dat> [output.svg] [--crop|--no-crop] [--scale=100] [--mixed-color-mode=error|first|average]"
    );
  }

  const [inputPath, outputPath] = positional;
  return {
    inputPath,
    outputPath:
      outputPath ??
      path.join(
        path.dirname(inputPath),
        `${path.basename(inputPath, path.extname(inputPath))}.svg`
      ),
    crop: options.crop,
    mixedColorMode: options.mixedColorMode,
    precision: Number.isFinite(options.precision) ? Math.max(0, options.precision) : 2,
    scale: Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 100,
  };
}

function parseIcon(buffer) {
  if (buffer.length < 8) {
    fail("Input is too small to be a Blender icon .dat file.");
  }

  const magic = buffer.subarray(0, 4).toString("ascii");
  if (magic !== "VCO\0") {
    fail(`Unsupported icon magic: ${JSON.stringify(magic)}`);
  }

  const width = buffer[4];
  const height = buffer[5];
  const startX = buffer[6];
  const startY = buffer[7];
  const payloadSize = buffer.length - 8;

  if (payloadSize % 18 !== 0) {
    fail(`Unexpected payload size ${payloadSize}; expected a multiple of 18 bytes.`);
  }

  const triangleCount = payloadSize / 18;
  const coordsOffset = 8;
  const colorsOffset = coordsOffset + triangleCount * 6;
  const triangles = [];

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const points = [];
    const colors = [];

    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      const coordOffset = coordsOffset + triangleIndex * 6 + vertexIndex * 2;
      points.push({
        x: buffer[coordOffset],
        y: buffer[coordOffset + 1],
      });

      const colorOffset = colorsOffset + triangleIndex * 12 + vertexIndex * 4;
      colors.push({
        r: buffer[colorOffset],
        g: buffer[colorOffset + 1],
        b: buffer[colorOffset + 2],
        a: buffer[colorOffset + 3],
      });
    }

    triangles.push({ points, colors });
  }

  return {
    width,
    height,
    startX,
    startY,
    triangles,
  };
}

function colorToKey(color) {
  return `${color.r},${color.g},${color.b},${color.a}`;
}

function resolveTriangleColor(colors, mixedColorMode, triangleIndex) {
  const unique = [...new Set(colors.map(colorToKey))];
  if (unique.length === 1) {
    return colors[0];
  }

  if (mixedColorMode === "first") {
    return colors[0];
  }

  if (mixedColorMode === "average") {
    const sum = colors.reduce(
      (acc, color) => ({
        r: acc.r + color.r,
        g: acc.g + color.g,
        b: acc.b + color.b,
        a: acc.a + color.a,
      }),
      { r: 0, g: 0, b: 0, a: 0 }
    );
    return {
      r: Math.round(sum.r / colors.length),
      g: Math.round(sum.g / colors.length),
      b: Math.round(sum.b / colors.length),
      a: Math.round(sum.a / colors.length),
    };
  }

  fail(
    `Triangle ${triangleIndex} uses multiple vertex colors (${unique.join(
      " | "
    )}). SVG export needs flat-shaded triangles, or rerun with --mixed-color-mode=first|average.`
  );
}

function formatNumber(value, precision) {
  const rounded = Number(value.toFixed(precision));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function rgbaToCss(color) {
  if (color.a === 255) {
    const hex = [color.r, color.g, color.b]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("");
    return {
      fill: `#${hex}`,
      opacity: null,
    };
  }

  return {
    fill: `rgb(${color.r} ${color.g} ${color.b})`,
    opacity: Number((color.a / 255).toFixed(6)),
  };
}

function buildSvg(icon, options) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const triangle of icon.triangles) {
    for (const point of triangle.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (!Number.isFinite(minX)) {
    fail("No triangles found in icon.");
  }

  const sourceMinX = options.crop ? minX : icon.startX;
  const sourceMinY = options.crop ? minY : icon.startY;
  const sourceMaxX = options.crop ? maxX : icon.startX + icon.width;
  const sourceMaxY = options.crop ? maxY : icon.startY + icon.height;
  const viewBoxWidth = (sourceMaxX - sourceMinX) * options.scale;
  const viewBoxHeight = (sourceMaxY - sourceMinY) * options.scale;
  const transformPoint = (point) => ({
    x: (point.x - sourceMinX) * options.scale,
    y: (sourceMaxY - point.y) * options.scale,
  });

  const segments = [];
  for (let triangleIndex = 0; triangleIndex < icon.triangles.length; triangleIndex += 1) {
    const triangle = icon.triangles[triangleIndex];
    const color = resolveTriangleColor(
      triangle.colors,
      options.mixedColorMode,
      triangleIndex
    );
    const colorKey = colorToKey(color);
    if (segments.length === 0 || segments[segments.length - 1].colorKey !== colorKey) {
      segments.push({
        color,
        colorKey,
        subpaths: [],
      });
    }

    const subpath = triangle.points
      .map((point, pointIndex) => {
        const transformed = transformPoint(point);
        const command = pointIndex === 0 ? "M" : "L";
        return `${command}${formatNumber(transformed.x, options.precision)} ${formatNumber(
          transformed.y,
          options.precision
        )}`;
      })
      .join(" ");

    segments[segments.length - 1].subpaths.push(`${subpath} Z`);
  }

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${formatNumber(
      viewBoxWidth,
      options.precision
    )} ${formatNumber(viewBoxHeight, options.precision)}" width="${formatNumber(
      viewBoxWidth,
      options.precision
    )}" height="${formatNumber(viewBoxHeight, options.precision)}">`,
  ];

  for (const { color, subpaths } of segments) {
    const css = rgbaToCss(color);
    const attrs = [`fill="${css.fill}"`];
    if (css.opacity !== null) {
      attrs.push(`fill-opacity="${css.opacity}"`);
    }
    lines.push(`  <path ${attrs.join(" ")} d="${subpaths.join(" ")}"/>`);
  }

  lines.push("</svg>");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const buffer = fs.readFileSync(options.inputPath);
  const icon = parseIcon(buffer);
  const svg = buildSvg(icon, options);

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, svg, "utf8");

  console.log(
    JSON.stringify(
      {
        input: options.inputPath,
        output: options.outputPath,
        triangles: icon.triangles.length,
        width: icon.width,
        height: icon.height,
        crop: options.crop,
        mixedColorMode: options.mixedColorMode,
      },
      null,
      2
    )
  );
}

main();
