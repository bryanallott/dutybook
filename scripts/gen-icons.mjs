import sharp from 'sharp'
import { mkdirSync } from 'fs'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#1a56db"/>
  <text x="256" y="360" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="320" fill="#fff">D</text>
</svg>`

const buf = Buffer.from(svg)

for (const size of [192, 512]) {
  await sharp(buf).resize(size, size).png().toFile(`public/icon-${size}.png`)
  console.log(`Created icon-${size}.png`)
}

// Also create a favicon
await sharp(buf).resize(32, 32).png().toFile('public/favicon.png')
console.log('Created favicon.png')
