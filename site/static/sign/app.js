import {
	donationLink,
	donationPlaceholder,
	parseDonation,
	parseLink,
	placeholder,
	qrPath,
	readSign,
	suggest,
	withPlaceholders,
	writeSign,
} from './lib.js';

/** @typedef {import('./lib.js').QrMode} QrMode */

/** @param {string} id */
const byId = id => /** @type {HTMLElement} */ (document.getElementById(id));
const form = /** @type {HTMLFormElement} */ (byId('sign-form'));
/** @param {string} name */
const field = name => /** @type {HTMLInputElement} */ (form.elements.namedItem(name));
/** @param {string} name */
const choice = name => /** @type {RadioNodeList} */ (form.elements.namedItem(name));

const header = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('header')),
	body = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('body')),
	qr = field('qr'),
	mode = choice('qr-mode'),
	pricing = choice('pricing');
const donationFields = {
	name: field('item'),
	price: field('price'),
	unit: field('unit'),
	min: field('min'),
	max: field('max'),
};
const linkSection = /** @type {HTMLFieldSetElement} */ (byId('sign-link-fields'));
const donationSection = /** @type {HTMLFieldSetElement} */ (byId('sign-donation-fields'));
const unitSection = /** @type {HTMLFieldSetElement} */ (byId('sign-unit-fields'));
const donationStatus = byId('sign-donation-status');
const preview = byId('sign-preview');
const sign = byId('sign');
const signHeader = byId('sign-header');
const signBody = byId('sign-body');
const signQr = byId('sign-qr');
const signQrSvg = /** @type {SVGSVGElement} */ (signQr.querySelector('svg'));
const signQrPath = /** @type {SVGPathElement} */ (signQrSvg.querySelector('path'));
const overflow = byId('sign-overflow');

let renderedLink = '';

/** @param {HTMLFieldSetElement} section @param {boolean} shown */
function show(section, shown) {
	section.hidden = !shown;
	section.disabled = !shown;
}

// Returns the link to encode ('' for none), the donation shown on the sign, and
// the typed QR value saved in the page URL. Blank fields use their placeholders.
function readQr() {
	const perUnit = pricing.value === 'unit';
	show(linkSection, mode.value === 'link');
	show(donationSection, mode.value === 'donation');
	show(unitSection, perUnit);
	if (mode.value === 'link') {
		qr.placeholder = placeholder.link;
		const link = parseLink(qr.value || qr.placeholder);
		qr.setCustomValidity(link === undefined ? 'Use an https link on thelab.ms or one of its subdomains.' : '');
		return { link: link ?? '', saved: qr.value };
	}
	if (mode.value !== 'donation') return { link: '', saved: '' };
	const hint = donationPlaceholder(perUnit);
	donationFields.name.placeholder = hint.name;
	donationFields.price.placeholder = hint.price;
	donationFields.unit.placeholder = hint.unit;
	const typed = {
		name: donationFields.name.value,
		price: donationFields.price.value,
		perUnit,
		unit: donationFields.unit.value,
		min: donationFields.min.value,
		max: donationFields.max.value,
	};
	const donation = withPlaceholders(typed);
	const { href, errors } = donationLink(donation);
	for (const [key, input] of Object.entries(donationFields)) {
		input.setCustomValidity(errors[/** @type {keyof typeof errors} */ (key)] ?? '');
	}
	const error = Object.values(errors)[0];
	if (error) {
		donationStatus.textContent = error;
	} else {
		const anchor = document.createElement('a');
		anchor.href = href;
		anchor.target = '_blank';
		anchor.rel = 'noopener';
		anchor.textContent = href;
		donationStatus.replaceChildren('Scans to ', anchor);
	}
	return { link: error ? '' : href, saved: donationLink(typed).href, donation };
}

function render() {
	const { link, saved, donation } = readQr();
	const suggested = suggest({ link, donation });
	header.placeholder = suggested.header;
	body.placeholder = suggested.body;
	signHeader.textContent = header.value || suggested.header;
	signBody.textContent = body.value || suggested.body;
	if (link !== renderedLink) {
		renderedLink = link;
		if (link) {
			const { size, d } = qrPath(link);
			signQrSvg.setAttribute('viewBox', `0 0 ${size} ${size}`);
			signQrPath.setAttribute('d', d);
		}
	}
	signQr.hidden = !renderedLink;
	overflow.hidden = sign.scrollHeight <= sign.clientHeight;
	history.replaceState(
		null,
		'',
		writeSign({ header: header.value, body: body.value, mode: /** @type {QrMode} */ (mode.value), qr: saved }) ||
			location.pathname,
	);
}

// The sign is laid out at full size (8.5 in = 816 CSS px) and zoomed to fit the preview.
function scalePreview() {
	sign.style.setProperty('--sign-scale', String(Math.min(1, preview.clientWidth / 816)));
}

const initial = readSign(location.search);
header.value = initial.header;
body.value = initial.body;
mode.value = initial.mode;
const donation = initial.mode === 'donation' ? parseDonation(initial.qr) : undefined;
if (donation) {
	pricing.value = donation.perUnit ? 'unit' : 'fixed';
	for (const key of /** @type {const} */ (['name', 'price', 'unit', 'min', 'max'])) {
		donationFields[key].value = donation[key];
	}
} else if (initial.mode === 'link') {
	qr.value = initial.qr;
}
render();
scalePreview();
new ResizeObserver(scalePreview).observe(preview);
form.addEventListener('input', render);
form.addEventListener('submit', async event => {
	event.preventDefault();
	await document.fonts.ready;
	render();
	print();
});
document.fonts.ready.then(render);
