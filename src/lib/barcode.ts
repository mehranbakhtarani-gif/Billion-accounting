const CODE39: Record<string, string> = {
  '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw',
  '5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
  'A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn',
  'F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
  'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn',
  'P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
  'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn',
  'Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','$':'nwnwnwnnn',
  '/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn','*':'nwnnwnwnn',
};

export function normalizeCode39(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized.length > 64 || [...normalized].some((char) => !CODE39[char] || char === '*')) {
    throw new Error('بارکد باید ۱ تا ۶۴ نویسه از حروف انگلیسی، عدد و علائم مجاز Code 39 باشد.');
  }
  return normalized;
}

export function code39Svg(value: string, height = 56): string {
  const normalized = normalizeCode39(value);
  const encoded = '*' + normalized + '*';
  const widths: number[] = [];
  const bars: boolean[] = [];
  for (const char of encoded) {
    const pattern = CODE39[char];
    for (let index = 0; index < pattern.length; index += 1) {
      widths.push(pattern[index] === 'w' ? 3 : 1);
      bars.push(index % 2 === 0);
    }
    widths.push(1);
    bars.push(false);
  }
  const total = widths.reduce((sum, width) => sum + width, 0);
  let x = 0;
  const rects = widths.map((width, index) => {
    const rect = bars[index] ? `<rect x="${x}" y="0" width="${width}" height="${height}" />` : '';
    x += width;
    return rect;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" role="img" aria-label="Code 39 ${normalized}" shape-rendering="crispEdges">${rects}</svg>`;
}
