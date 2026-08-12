export class NextResponse extends Response {
  static next() {
    return new NextResponse(null, { status: 200 });
  }

  static json(data: unknown, init?: ResponseInit) {
    return new Response(JSON.stringify(data), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
  }

  static redirect(url: string | URL, status = 307) {
    return new Response(null, {
      status,
      headers: { Location: typeof url === 'string' ? url : url.toString() },
    });
  }
}

export class NextRequest extends Request {
  nextUrl: URL;

  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  }
}
