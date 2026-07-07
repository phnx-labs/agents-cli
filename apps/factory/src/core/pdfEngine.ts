import * as fs from 'fs';

export type PdfEngine =
  | { kind: 'chrome'; binary: string }
  | { kind: 'prince'; binary: string };

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const PRINCE_CANDIDATES = [
  '/usr/local/bin/prince',
  '/opt/homebrew/bin/prince',
  '/usr/bin/prince',
];

export interface ResolveOptions {
  exists?: (p: string) => boolean;
  chromeCandidates?: string[];
  princeCandidates?: string[];
}

export function resolvePdfEngine(opts: ResolveOptions = {}): PdfEngine | null {
  const exists = opts.exists ?? ((p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });

  const chromes = opts.chromeCandidates ?? CHROME_CANDIDATES;
  for (const p of chromes) {
    if (exists(p)) return { kind: 'chrome', binary: p };
  }

  const princes = opts.princeCandidates ?? PRINCE_CANDIDATES;
  for (const p of princes) {
    if (exists(p)) return { kind: 'prince', binary: p };
  }

  return null;
}

export function buildPdfArgs(
  engine: PdfEngine,
  htmlPath: string,
  pdfPath: string,
): string[] {
  if (engine.kind === 'chrome') {
    return [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ];
  }
  return [htmlPath, '-o', pdfPath];
}
