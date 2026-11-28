const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const assetsDirectory = __dirname;
const source = PNG.sync.read(fs.readFileSync(path.join(assetsDirectory, "slash-app-icon-source.png")));
const cropSize = Math.min(source.width, source.height);
const cropLeft = Math.floor((source.width - cropSize) / 2);
const cropTop = Math.floor((source.height - cropSize) / 2);
const iconSource = new PNG({ width: cropSize, height: cropSize });
for (let y = 0; y < cropSize; y++) {
    const sourceStart = ((cropTop + y) * source.width + cropLeft) * 4;
    const targetStart = y * cropSize * 4;
    source.data.copy(iconSource.data, targetStart, sourceStart, sourceStart + cropSize * 4);
}
const sizes = [16, 24, 32, 48, 64, 128, 256];

function render(size) {
    const image = new PNG({ width: size, height: size });
    const scale = size / iconSource.width;
    const width = iconSource.width * scale;
    const height = iconSource.height * scale;
    const left = (size - width) / 2;
    const top = (size - height) / 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (x + 0.5 < left || x + 0.5 > left + width || y + 0.5 < top || y + 0.5 > top + height) continue;
            const sx = Math.max(0, Math.min(iconSource.width - 1, (x + 0.5 - left) / scale - 0.5));
            const sy = Math.max(0, Math.min(iconSource.height - 1, (y + 0.5 - top) / scale - 0.5));
            const x0 = Math.floor(sx), y0 = Math.floor(sy);
            const x1 = Math.min(iconSource.width - 1, x0 + 1), y1 = Math.min(iconSource.height - 1, y0 + 1);
            const fx = sx - x0, fy = sy - y0;
            const target = (y * size + x) * 4;
            for (let channel = 0; channel < 4; channel++) {
                const a = iconSource.data[(y0 * iconSource.width + x0) * 4 + channel];
                const b = iconSource.data[(y0 * iconSource.width + x1) * 4 + channel];
                const c = iconSource.data[(y1 * iconSource.width + x0) * 4 + channel];
                const d = iconSource.data[(y1 * iconSource.width + x1) * 4 + channel];
                image.data[target + channel] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy);
            }
        }
    }
    return PNG.sync.write(image, { deflateLevel: 9 });
}

const iconImages = sizes.map(size => ({ size, png: render(size) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(iconImages.length, 4);
const entries = [];
let offset = 6 + iconImages.length * 16;
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
fs.writeFileSync(path.join(assetsDirectory, "cafe-pilot-icon.ico"), Buffer.concat([header, ...entries, ...iconImages.map(image => image.png)]));
fs.writeFileSync(path.join(assetsDirectory, "cafe-pilot-icon.png"), render(512));
console.log("Generated Slash icon: 7 ICO sizes (16–256 px) and 512 px PNG preview.");
