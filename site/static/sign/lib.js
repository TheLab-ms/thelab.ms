import { encode } from '../vendor/uqr.mjs';

/** @typedef {'none' | 'link' | 'donation'} QrMode */
/** @typedef {{ header: string, body: string, mode: QrMode, qr: string }} Sign */
/** @typedef {{ name: string, price: string, perUnit: boolean, unit: string, min: string, max: string }} Donation */
/** @typedef {'name' | 'price' | 'unit' | 'min' | 'max'} DonationField */

// Shown, and printed, wherever a field is left blank.
export const placeholder = {
	header: 'Your headline here',
	body: 'Add a few words of detail.',
	link: 'https://thelab.ms/links',
};

/** @param {boolean} perUnit */
export const donationPlaceholder = perUnit =>
	perUnit ? { name: 'PLA filament', price: '0.10', unit: 'gram' } : { name: 'Soda', price: '1.50', unit: '' };

// Blank builder fields take their placeholders, as the preview shows them.
/** @param {Donation} donation @returns {Donation} */
export function withPlaceholders(donation) {
	const hint = donationPlaceholder(donation.perUnit);
	return {
		...donation,
		name: donation.name || hint.name,
		price: donation.price || hint.price,
		unit: donation.unit || hint.unit,
	};
}

const REDEEM = 'https://thelab.ms/wallet/redeem';

// QR codes may only point at TheLab's own sites. Returns '' for no QR code and
// undefined when the value is not an allowed link.
/** @param {string} value */
export function parseLink(value) {
	const trimmed = value.trim();
	if (!trimmed) return '';
	let url;
	try {
		url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
	} catch {
		return undefined;
	}
	const host = url.hostname;
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
	return host === 'thelab.ms' || host.endsWith('.thelab.ms') ? url.href : undefined;
}

// One SVG path of unit squares, drawn without a quiet zone; the page margin is wider.
/** @param {string} href */
export function qrPath(href) {
	const { size, data } = encode(href, { ecc: 'M', border: 0 });
	let d = '';
	for (const [y, row] of data.entries()) {
		for (const [x, dark] of row.entries()) if (dark) d += `M${x} ${y}h1v1h-1z`;
	}
	return { size, d };
}

/** @type {QrMode[]} */
const MODES = ['none', 'link', 'donation'];

// Links saved before the mode was recorded imply it from the QR link.
/** @param {string} search @returns {Sign} */
export function readSign(search) {
	const params = new URLSearchParams(search);
	const qr = params.get('qr') ?? '';
	const mode =
		MODES.find(mode => mode === params.get('mode')) ?? (qr ? (parseDonation(qr) ? 'donation' : 'link') : 'none');
	return { header: params.get('header') ?? '', body: params.get('body') ?? '', mode, qr };
}

// Only non-empty fields are kept, so a blank sign is just /sign.
/** @param {Sign} sign */
export function writeSign(sign) {
	const params = new URLSearchParams(
		Object.entries(sign).filter(([key, value]) => value && !(key === 'mode' && value === 'none')),
	);
	const query = String(params);
	return query ? `?${query}` : '';
}

// Suggested header and body text for the chosen QR code. They fill the blank
// fields as placeholders, so anything typed replaces them.
/** @param {{ link: string, donation?: Donation | undefined }} qr */
export function suggest({ link, donation }) {
	if (donation) {
		const name = donation.name.trim();
		return {
			header: name || placeholder.header,
			body: link
				? `Suggested donation: ${donationPrice(donation)}\nScan to pay with your TheLab wallet.`
				: placeholder.body,
		};
	}
	return { header: placeholder.header, body: link || placeholder.body };
}

// Matches how the wallet shows prices: cents, or every digit of a sub-cent unit price.
/** @param {Donation} donation */
function donationPrice({ price, perUnit, unit }) {
	const value = Number(money(price));
	const cents = Math.round(value * 100);
	const text =
		Math.abs(value * 100 - cents) < 1e-9
			? `$${(cents / 100).toFixed(2)}`
			: `$${value.toFixed(4).replace(/0+$/, '')}`;
	return perUnit ? `${text} per ${unit.trim()}` : text;
}

// Wallet donation links. These rules mirror readSpec in src/wallet.tsx so a
// printed code never leads to an error page.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Control characters are rejected like the wallet does.
const CONTROL = /[\x00-\x1f\x7f]/;
const PRICE = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;
const CENTS = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/;
const QUANTITY = /^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/;

/** @param {string} value */
const money = value => {
	const text = value.trim().replace(/^\$\s*/, '');
	return text.startsWith('.') ? `0${text}` : text;
};

/** @param {string} value @param {number} max */
const validLabel = (value, max) => value.length > 0 && value.length <= max && !CONTROL.test(value);

// Reads the builder fields back out of a wallet donation link, or returns
// undefined for any other link.
/** @param {string} value @returns {Donation | undefined} */
export function parseDonation(value) {
	const href = parseLink(value);
	if (!href) return undefined;
	const url = new URL(href);
	if (`${url.origin}${url.pathname}` !== REDEEM) return undefined;
	const read = (/** @type {string} */ name) => url.searchParams.get(name) ?? '';
	return {
		name: read('n'),
		price: read('p'),
		perUnit: url.searchParams.has('u'),
		unit: read('u'),
		min: read('min'),
		max: read('max'),
	};
}

// Builds the wallet link from the builder fields. The link keeps partial input
// so the form survives a reload, but it only makes a QR code once errors is empty.
/** @param {Donation} donation */
export function donationLink(donation) {
	/** @type {Partial<Record<DonationField, string>>} */
	const errors = {};
	const name = donation.name.trim(),
		price = money(donation.price),
		unit = donation.unit.trim(),
		min = donation.min.trim(),
		max = donation.max.trim();
	const params = new URLSearchParams();
	if (name) params.set('n', name);
	if (price) params.set('p', price);
	if (!validLabel(name, 80)) errors.name = 'Enter an item name of up to 80 characters.';
	if (donation.perUnit) {
		params.set('u', unit);
		if (min) params.set('min', min);
		if (max) params.set('max', max);
		if (!PRICE.test(price) || !(Number(price) > 0))
			errors.price = 'Enter a price per unit from $0.0001 to $999.9999.';
		if (!validLabel(unit, 20)) errors.unit = 'Enter a unit of up to 20 characters, like gram.';
		if (min && !QUANTITY.test(min)) errors.min = 'Enter a minimum up to 99999.99, or leave it blank.';
		if (max && !QUANTITY.test(max)) errors.max = 'Enter a maximum up to 99999.99, or leave it blank.';
		else if (min && max && !errors.min && Number(max) <= Number(min))
			errors.max = 'The maximum must be more than the minimum.';
	} else if (!CENTS.test(price) || !(Number(price) > 0)) {
		errors.price = 'Enter a price from $0.01 to $999.99.';
	}
	const query = String(params);
	return { href: query ? `${REDEEM}?${query}` : REDEEM, errors };
}
