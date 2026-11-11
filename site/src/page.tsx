import { h, Fragment, render, type Child } from './html.ts';

// Browsers apply form-action to redirects after a submission, so pages whose
// forms end at Stripe Checkout must allow it.
const htmlHeaders = (checkout: boolean) => ({
	'Content-Type': 'text/html; charset=utf-8',
	'Cache-Control': 'no-store',
	// no-referrer can turn the Origin of a native form POST into "null".
	'Referrer-Policy': 'same-origin',
	'X-Content-Type-Options': 'nosniff',
	'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'${checkout ? ' https://checkout.stripe.com' : ''}; base-uri 'none'; frame-ancestors 'none'`,
});

interface PageOptions {
	status?: number;
	admin?: boolean;
	dev?: boolean;
	checkout?: boolean;
	wide?: boolean;
	adminSection?: 'members' | 'logs';
	afterCard?: Child;
}

export function page(title: string, body: Child, options: PageOptions = {}) {
	const { status = 200, admin = false, checkout = false } = options;
	const content = admin ? (
		<>
			<header class="admin-header">
				<a class="membership-brand" href="/">
					TheLab
				</a>
				<nav aria-label="Admin navigation">
					<a href="/admin" aria-current={options.adminSection !== 'logs' ? 'page' : undefined}>
						Members
					</a>
					<a href="/admin/events" aria-current={options.adminSection === 'logs' ? 'page' : undefined}>
						Logs
					</a>
					<a href="/events/new">Add event</a>
					<a href="http://edge.thelab.ms/">Edge proxy</a>
				</nav>
				<div class="admin-toolbar-actions">
					<form method="post" action="/logout">
						<button class="btn btn-outline" type="submit">
							Log out
						</button>
					</form>
				</div>
			</header>
			<h1>{title}</h1>
			{body}
		</>
	) : (
		<>
			<a class="membership-brand" href="/">
				<img src="/assets/favicon.svg" alt="" width="48" height="48" />
				TheLab
			</a>
			<section class="card membership-message">
				<h1>{title}</h1>
				{body}
			</section>
			{options.afterCard}
		</>
	);
	const document = (
		<html lang="en">
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
				<a class="skip-link" href="#main">
					Skip to content
				</a>
				<main
					id="main"
					class={`container membership-main${admin ? ' admin-main' : ''}${options.wide ? ' event-main' : ''}`}
				>
					{content}
				</main>
			</body>
		</html>
	);
	return new Response(`<!doctype html>${render(document)}`, { status, headers: htmlHeaders(checkout) });
}
