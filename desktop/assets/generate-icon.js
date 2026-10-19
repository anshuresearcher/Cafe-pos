// Generates the multi-size Windows icon and its PNG preview without extra packages.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const outputDirectory = __dirname;
const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const antialiasSamples = 4;

function rgb(hex) {
    return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}

function mix(a, b, amount) {
    return a.map((value, index) => Math.round(value + (b[index] - value) * amount));
}

function composite(base, color, opacity) {
    return mix(base, color, opacity);
}

function ellipseContains(x, y, cx, cy, rx, ry) {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
}

function polygonContains(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (crosses) inside = !inside;
    }
    return inside;
}

function cubicPoints(start, controlOne, controlTwo, end, steps = 32) {
    const result = [];
    for (let index = 1; index <= steps; index++) {
        const t = index / steps;
        const u = 1 - t;
        const x = u ** 3 * start[0] + 3 * u ** 2 * t * controlOne[0] + 3 * u * t ** 2 * controlTwo[0] + t ** 3 * end[0];
        const y = u ** 3 * start[1] + 3 * u ** 2 * t * controlOne[1] + 3 * u * t ** 2 * controlTwo[1] + t ** 3 * end[1];
        result.push([x, y]);
    }
    return result;
}

function distanceToSegment(x, y, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared));
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function lineContains(x, y, points, width) {
    for (let index = 1; index < points.length; index++) {
        if (distanceToSegment(x, y, points[index - 1], points[index]) <= width / 2) return true;
    }
    return false;
}

const mug = [[68, 92], [177, 92], [174, 145], [170, 168]]
    .concat(cubicPoints([170, 168], [168, 188], [153, 200], [134, 200]))
    .concat([[108, 200]])
    .concat(cubicPoints([108, 200], [88, 200], [76, 187], [74, 168]))
    .concat([[68, 92]]);
const latteArt = cubicPoints([112, 95], [114, 86], [124, 86], [131, 92], 24)
    .concat(cubicPoints([131, 92], [126, 99], [118, 100], [112, 95], 20));
const steamLines = [
    cubicPoints([91, 77], [84, 68], [98, 61], [93, 51]),
    cubicPoints([121, 77], [130, 68], [114, 60], [123, 49]),
    cubicPoints([151, 77], [145, 68], [158, 61], [154, 51])
];

function colorAt(x, y) {
    const dx = Math.abs(x - 128) - 58;
    const dy = Math.abs(y - 128) - 58;
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - 56;
    if (outside > 0) return [0, 0, 0, 0];

    const gradient = Math.max(0, Math.min(1, (x + y * 0.38) / 320));
    let color = mix(rgb("214b55"), rgb("172334"), gradient);
    const glowDistance = Math.hypot((x - 183) * 0.78, (y - 66) * 0.95);
    color = composite(color, rgb("36b8a5"), Math.max(0, 0.22 * (1 - glowDistance / 125)));
    if (outside > -1.5) color = composite(color, rgb("ffffff"), 0.13);

    if (ellipseContains(x, y, 122, 205, 62, 8)) color = composite(color, rgb("2aa99d"), 0.9);

    const handleOuter = ellipseContains(x, y, 180, 132, 25, 27);
    const handleInner = ellipseContains(x, y, 180, 132, 12, 15);
    if (handleOuter && !handleInner) {
        const handleMix = Math.max(0, Math.min(1, (y - 105) / 54));
        color = mix(rgb("58d3bd"), rgb("2da99f"), handleMix);
    }

    if (polygonContains(x, y, mug)) color = mix(rgb("fff8e9"), rgb("f0d8b5"), Math.max(0, Math.min(1, (x + y * 0.5 - 90) / 210)));
    if (ellipseContains(x, y, 122.5, 94, 55.5, 15.5)) color = rgb("d8b68f");
    if (ellipseContains(x, y, 122.5, 92.5, 48, 9.5)) color = rgb("563728");
    if (lineContains(x, y, latteArt, 2)) color = rgb("d8a76a");

    if (lineContains(x, y, [[78, 119], [80, 140], [82, 163], [86, 178], [96, 190]], 4)) {
        color = composite(color, rgb("ffffff"), 0.48);
    }
    if (steamLines.some(points => lineContains(x, y, points, 5.5))) color = rgb("f4d28e");
    return [...color, 255];
}

function renderPixels(size) {
    const pixels = Buffer.alloc(size * size * 4);
    const sampleCount = antialiasSamples ** 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sum = [0, 0, 0, 0];
            for (let sy = 0; sy < antialiasSamples; sy++) {
                for (let sx = 0; sx < antialiasSamples; sx++) {
                    const iconX = (x + (sx + 0.5) / antialiasSamples) * 256 / size;
                    const iconY = (y + (sy + 0.5) / antialiasSamples) * 256 / size;
                    const sample = colorAt(iconX, iconY);
                    for (let channel = 0; channel < 4; channel++) sum[channel] += sample[channel];
                }
            }
            const offset = (y * size + x) * 4;
            for (let channel = 0; channel < 4; channel++) pixels[offset + channel] = Math.round(sum[channel] / sampleCount);
        }
    }
    return pixels;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    crcTable[n] = value >>> 0;
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
    return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(size, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    const scanlines = Buffer.alloc((size * 4 + 1) * size);
    for (let row = 0; row < size; row++) {
        const destination = row * (size * 4 + 1);
        scanlines[destination] = 0;
        pixels.copy(scanlines, destination + 1, row * size * 4, (row + 1) * size * 4);
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
}

const iconImages = iconSizes.map(size => ({ size, png: encodePng(size, renderPixels(size)) }));
const directorySize = 6 + iconImages.length * 16;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(iconImages.length, 4);
const entries = [];
let offset = directorySize;
for (const image of iconImages) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size === 256 ? 0 : image.size;
    entry[1] = image.size === 256 ? 0 : image.size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.png.length;
}

fs.writeFileSync(path.join(outputDirectory, "cafe-pilot-icon.ico"), Buffer.concat([header, ...entries, ...iconImages.map(image => image.png)]));
fs.writeFileSync(path.join(outputDirectory, "cafe-pilot-icon.png"), encodePng(512, renderPixels(512)));
console.log("Generated Slash icon: 7 ICO sizes (16–256 px) and 512 px PNG preview.");
