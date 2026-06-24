type SpinnerColor = 'cyan' | 'green' | 'red' | 'yellow' | string;

interface OraOptions {
  text?: string;
  color?: SpinnerColor;
}

export interface Ora {
  text: string;
  start(text?: string): Ora;
  stop(): Ora;
  succeed(text?: string): Ora;
  fail(text?: string): Ora;
}

const frames = ['-', '\\', '|', '/'];
const useColor = (): boolean =>
  Boolean(process.stderr.isTTY && !process.env.NO_COLOR);

function normalize(input?: string | OraOptions): Required<OraOptions> {
  if (typeof input === 'string') return { text: input, color: 'cyan' };
  return { text: input?.text ?? '', color: input?.color ?? 'cyan' };
}

function colorize(value: string, color: SpinnerColor): string {
  if (!useColor()) return value;
  const code = color === 'green'
    ? 32
    : color === 'red'
      ? 31
      : color === 'yellow'
        ? 33
        : 36;
  return `\x1b[${code}m${value}\x1b[39m`;
}

class TinySpinner implements Ora {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly color: SpinnerColor;
  private _text: string;

  constructor(input?: string | OraOptions) {
    const options = normalize(input);
    this._text = options.text;
    this.color = options.color;
  }

  get text(): string {
    return this._text;
  }

  set text(value: string) {
    this._text = value;
    if (this.timer) this.render();
  }

  start(text?: string): Ora {
    if (text !== undefined) this._text = text;
    if (!process.stderr.isTTY) {
      if (this._text) console.error(this._text);
      return this;
    }
    if (!this.timer) this.timer = setInterval(() => this.render(), 80);
    this.render();
    return this;
  }

  stop(): Ora {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
    return this;
  }

  succeed(text?: string): Ora {
    return this.finish('✓', 'green', text);
  }

  fail(text?: string): Ora {
    return this.finish('✗', 'red', text);
  }

  private render(): void {
    const frame = frames[this.frame++ % frames.length];
    process.stderr.write(`\r\x1b[2K${colorize(frame, this.color)} ${this._text}`);
  }

  private finish(symbol: string, color: SpinnerColor, text?: string): Ora {
    const message = text ?? this._text;
    if (!process.stderr.isTTY) {
      if (message) console.error(message);
      return this;
    }
    this.stop();
    console.error(message ? `${colorize(symbol, color)} ${message}` : colorize(symbol, color));
    return this;
  }
}

export default function ora(input?: string | OraOptions): Ora {
  return new TinySpinner(input);
}
