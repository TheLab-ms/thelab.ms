import { h, Fragment, render, type Child } from './html.ts';

const htmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  // no-referrer can turn the Origin of a native form POST into "null".
  'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function page(title: string, body: Child, { status = 200, admin = false } = {}) {
  const content = admin ? <>
    <header class="admin-header">
      <a class="membership-brand" href="/">TheLab</a>
      <nav aria-label="Admin navigation"><a href="/admin">Members</a><a href="/admin/events">Events</a></nav>
      <div class="admin-toolbar-actions">
        <form method="post" action="/logout"><button class="btn btn-outline" type="submit">Log Out</button></form>
      </div>
    </header>
    <h1>{title}</h1>
    {body}
  </> : <>
    <a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="48" height="48" />TheLab</a>
    <section class="card membership-message"><h1>{title}</h1>{body}</section>
  </>;
  const document = <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title} | TheLab</title>
      <link rel="icon" href="/assets/favicon.svg" />
      <link rel="stylesheet" href="/style.css" />
      {admin && <script src="/admin.js" defer />}
    </head>
    <body class={`membership-page${admin ? ' admin-page' : ''}`}>
      <main class={`container membership-main${admin ? ' admin-main' : ''}`}>{content}</main>
    </body>
  </html>;
  return new Response(`<!doctype html>${render(document)}`, { status, headers: htmlHeaders });
}
