import { getPublicUrl } from "../_shared/utils.ts";

// Generates an HTML page containing OpenGraph metadata so that social media sites
// (Facebook, etc.) show a proper preview when someone shares a Bloom Library link.
// The page immediately redirects real visitors to the target link via javascript.
//
// Input URL looks something like
// /social?link=<url>&title=<title>&img=<imgUrl>&description=<description>
// Parameters may come from the GET query string or a POST JSON body.

export async function handleSocialRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      const parsed = await req.json();
      // req.json() yields whatever the body decodes to, including null or a
      // primitive for a body like `null` or `42`. Only keep it if it's an
      // object; otherwise body[name] below would throw on null.
      if (typeof parsed === "object" && parsed !== null) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // no JSON body; parameters may still be in the query string
    }
  }

  const getParam = (name: string): string | undefined => {
    const fromQuery = url.searchParams.get(name);
    if (fromQuery !== null) return fromQuery;
    const fromBody = body[name];
    return fromBody === undefined ? undefined : String(fromBody);
  };

  const linkUrl = getParam("link");

  if (!isAllowedLink(linkUrl)) {
    return new Response(
      "403 Error: Creating a link to that resource is not allowed.",
      { status: 403 }
    );
  }

  const title = getParam("title");
  const imgUrl = getParam("img");
  const imgWidth = getParam("width") || "256";
  const imgHeight = getParam("height") || "256";
  const description = getParam("description");

  if (linkUrl && title) {
    // isAllowedLink accepts a scheme-less link (e.g. "bloomlibrary.org/book/1"),
    // but that value used verbatim in window.location.href would be treated as
    // a relative path and bounce the visitor to a broken address under this
    // function's own host. Give an allowed scheme-less link an explicit scheme.
    const redirectUrl =
      !linkUrl.startsWith("http://") && !linkUrl.startsWith("https://")
        ? "https://" + linkUrl
        : linkUrl;
    return new Response(
      createLinkHtml(
        getPublicUrl(req).toString(),
        redirectUrl,
        title,
        imgUrl,
        imgWidth,
        imgHeight,
        description
      ),
      { headers: { "Content-Type": "text/html" } }
    );
  }
  return new Response(
    "Please pass a link url, title, img url, and description in the GET query string or in the POST request JSON",
    { status: 400 }
  );
}

// Returns true if the user is allowed to create a link to that resource,
// or false if the link is not allowed (e.g. external link).
export function isAllowedLink(linkUrl: string | undefined | null): boolean {
  if (!linkUrl) {
    // Even though it's not a very useful link, we don't want to return a disallowed message for it.
    // Return true for now. Let some other code deal with this.
    return true;
  }

  // URL Constructor is unhappy if it doesn't start with the protocol.
  let candidate = linkUrl;
  if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) {
    candidate = "http://" + candidate;
  }
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();

    // Allow bloomlibrary.org, or its subdomains, but not any links to any other domain.
    return (
      !!hostname &&
      (hostname === "bloomlibrary.org" || hostname.endsWith(".bloomlibrary.org"))
    );
  } catch {
    // Probably a malformed URL
    return false;
  }
}

// Escape a value for interpolation into HTML text or a double-quoted attribute.
// (The Azure version interpolated raw values; escaping prevents HTML injection
// via the title/description/img parameters without changing legitimate output.)
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Produce a javascript string literal that is safe to embed inside a <script> element.
function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function createLinkHtml(
  originalUrl: string,
  linkUrl: string,
  title: string,
  imgUrl: string | undefined,
  imgWidth: string,
  imgHeight: string,
  description: string | undefined
): string {
  return (
    `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta
            property="og:title"
            content="${escapeHtml(title)}"
        />
        <meta property="og:type" content="website" />` +
    // og:image:width and og:image:height reserve space for the image until it can be loaded.  If
    // the image is not close to being square, the link display may not try to fit it in the square
    // to the left of the display but may display the image across the top of the link display.
    // The role of the size is unclear. But it seems to at least effect the croping or sizing.
    //  The preview code reserved a 158x158
    // square for an image that we claimed to be 256x256. This behavior is what we want for book thumbnails
    //  if that's what facebook is going to fit the final image into. But don't forget this is for more than
    // thumbnails. It's for any page on blorg, which will include different shapes of images.
    (imgUrl
      ? `
        <meta
          property = "og:image"
          content = "${escapeHtml(imgUrl)}"
        />
        <meta property="og:image:width" content = "${escapeHtml(imgWidth)}" />
        <meta property="og:image:height" content = "${escapeHtml(imgHeight)}" />`
      : "") +
    `
        <meta
            property="og:description"
            content="${escapeHtml(
              description ||
                "Bloom makes it easy to create simple books and translate them into multiple languages."
            )}"
        />` +
    // og:url must be set to originalUrl.  Using linkUrl instead does not work because the link is
    // followed and its HTML is scraped to find the values for the other OpenGraph metadata.  Note
    // that link preview shows the base website of og: url's value (eg, source.bloomlibrary.org or
    // whatever) as part of the display.
    `
        <meta
            property="og:url"
            content="${escapeHtml(originalUrl)}"
        />` +
    // og:site_name is called "optional" and "generally recommended" by https://ogp.me.  og:site_name
    // is described thusly: "If your object is part of a larger web site, the name which should be
    // displayed for the overall site."  This sounds promising enough to include, but Facebook appears
    // to ignore it.
    `
        <meta
            property="og:site_name"
            content="bloomlibrary.org"
        />
        <title>${escapeHtml(title)}</title>` +
    // When the user clicks on a link that generates this HTML (or finds a way to navigate to it directly),
    // we want them to end up at linkUrl which will usually be a book or page on bloomlibrary.org.  When
    // displayed, this script causes this HTML content to be totally replaced without any trace left behind.
    `
        <script>
            window.location.href=${jsStringLiteral(linkUrl)};
        </script>
    </head>
    <body>
    </body>
</html>
`
  );
}
