import sharp from 'sharp'

// Matches the prototype's brand mark: red/yellow split square on sea background
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0E2A3B"/>
  <rect x="146" y="96" width="220" height="160" rx="16" fill="#D3242B"/>
  <rect x="146" y="256" width="220" height="160" rx="16" fill="#F5C518"/>
  <text x="256" y="220" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="120" fill="#fff">D</text>
  <text x="256" y="380" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="120" fill="#1E1800">B</text>
</svg>`

const buf = Buffer.from(svg)

for (const size of [192, 512]) {
  await sharp(buf).resize(size, size).png().toFile(`public/icon-${size}.png`)
  console.log(`Created icon-${size}.png`)
}

await sharp(buf).resize(32, 32).png().toFile('public/favicon.png')
console.log('Created favicon.png')
