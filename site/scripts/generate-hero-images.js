import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const assets = new URL('../static/assets/', import.meta.url);
const source = fileURLToPath(new URL('streetview.jpg', assets));
const widths = [640, 960, 1280, 1920, 2560];

// Keep the original as the source; commit these derivatives for static serving.
for (const width of widths) {
  for (const format of ['webp', 'jpg']) {
    const name = `streetview-${width}.${format}`;
    const image = sharp(source).autoOrient().resize({ width, withoutEnlargement: true });
    if (format === 'webp') {
      image.webp({ quality: 78 });
    } else {
      image.jpeg({ quality: 80, mozjpeg: true });
    }
    const result = await image.toFile(fileURLToPath(new URL(name, assets)));
    console.log(`${name}: ${result.width}×${result.height}, ${(result.size / 1024).toFixed(1)} KiB`);
  }
}
