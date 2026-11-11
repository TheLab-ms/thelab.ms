import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'uqr';
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
} from '../../static/sign/lib.js';

test('vendored uqr matches the installed package', () => {
	for (const [vendored, installed] of [
		['uqr.mjs', 'index.mjs'],
		['uqr.d.mts', 'index.d.mts'],
	]) {
		assert.equal(
			readFileSync(new URL(`../../static/vendor/${vendored}`, import.meta.url), 'utf8'),
			readFileSync(new URL(`../../node_modules/uqr/dist/${installed}`, import.meta.url), 'utf8'),
			`Copy node_modules/uqr/dist/${installed} to static/vendor/${vendored}`,
		);
	}
});

test('QR links must be https on thelab.ms or its subdomains', () => {
	assert.equal(parseLink(''), '');
	assert.equal(parseLink('   '), '');
	assert.equal(parseLink('https://thelab.ms'), 'https://thelab.ms/');
	assert.equal(parseLink(' https://thelab.ms/waiver?x=1#top '), 'https://thelab.ms/waiver?x=1#top');
	assert.equal(parseLink('https://wiki.thelab.ms/Laser'), 'https://wiki.thelab.ms/Laser');
	assert.equal(parseLink('HTTPS://THELAB.MS/links'), 'https://thelab.ms/links');
	assert.equal(parseLink('thelab.ms/links'), 'https://thelab.ms/links');
	assert.equal(parseLink('discord.thelab.ms'), 'https://discord.thelab.ms/');
	for (const link of [
		'http://thelab.ms',
		'https://thelab.ms.example.com',
		'https://notthelab.ms',
		'https://example.com/thelab.ms',
		'https://thelab.ms@example.com',
		'https://user:pass@thelab.ms',
		'https://thelab.ms:8443',
		'javascript:alert(1)',
		'mailto:hi@thelab.ms',
		'https://',
		'not a url',
	]) {
		assert.equal(parseLink(link), undefined, link);
	}
});

test('QR path draws exactly the dark modules', () => {
	const href = 'https://thelab.ms/waiver';
	const { size, d } = qrPath(href);
	const { data } = encode(href, { ecc: 'M', border: 0 });
	assert.equal(size, data.length);
	const drawn = new Set([...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(([, x, y]) => `${x},${y}`));
	const dark = new Set(data.flatMap((row, y) => row.flatMap((on, x) => (on ? [`${x},${y}`] : []))));
	assert.deepEqual(drawn, dark);
	assert.equal(d.replaceAll(/M\d+ \d+h1v1h-1z/g, ''), '');
});

const fixed = { name: '', price: '', perUnit: false, unit: '', min: '', max: '' };

test('sign content round-trips through the query string', () => {
	const blank = { header: '', body: '', mode: 'none', qr: '' } as const;
	assert.deepEqual(readSign(''), blank);
	assert.equal(writeSign(blank), '');
	const sign = { header: 'No food\n& drinks', body: 'Keep it clean <3', mode: 'none', qr: '' } as const;
	assert.equal(writeSign(sign), '?header=No+food%0A%26+drinks&body=Keep+it+clean+%3C3');
	assert.deepEqual(readSign(writeSign(sign)), sign);
	assert.deepEqual(readSign('?header=Hi'), { ...blank, header: 'Hi' });
	// The mode survives with nothing typed, so a placeholder QR code comes back too.
	assert.equal(writeSign({ ...blank, mode: 'link' }), '?mode=link');
	assert.deepEqual(readSign('?mode=link'), { ...blank, mode: 'link' });
	assert.deepEqual(readSign('?mode=bogus'), blank);
	// Older links imply the mode from the QR link.
	assert.equal(readSign('?qr=thelab.ms').mode, 'link');
	assert.equal(readSign('?qr=https%3A%2F%2Fthelab.ms%2Fwallet%2Fredeem%3Fn%3DSoda').mode, 'donation');
});

test('blank donation fields use placeholders', () => {
	for (const perUnit of [false, true]) {
		const filled = withPlaceholders({ ...fixed, perUnit });
		assert.deepEqual(donationLink(filled).errors, {}, `perUnit: ${perUnit}`);
		assert.equal(filled.name, donationPlaceholder(perUnit).name);
	}
	assert.deepEqual(withPlaceholders({ ...fixed, name: 'Gum', price: '0.25' }), {
		...fixed,
		name: 'Gum',
		price: '0.25',
	});
	assert.equal(parseLink(placeholder.link), placeholder.link);
});

test('suggested text follows the QR code', () => {
	const generic = { header: placeholder.header, body: placeholder.body };
	assert.deepEqual(suggest({ link: '' }), generic);
	assert.deepEqual(suggest({ link: 'https://thelab.ms/waiver' }), {
		header: placeholder.header,
		body: 'https://thelab.ms/waiver',
	});
	const soda = { name: ' Soda ', price: '$1.5', perUnit: false, unit: '', min: '', max: '' };
	assert.deepEqual(suggest({ link: donationLink(soda).href, donation: soda }), {
		header: 'Soda',
		body: 'Suggested donation: $1.50\nScan to pay with your TheLab wallet.',
	});
	const filament = { name: 'Filament', price: '.0025', perUnit: true, unit: ' gram ', min: '', max: '' };
	assert.equal(
		suggest({ link: donationLink(filament).href, donation: filament }).body,
		'Suggested donation: $0.0025 per gram\nScan to pay with your TheLab wallet.',
	);
	assert.equal(
		suggest({ link: 'x', donation: { ...filament, price: '0.10' } }).body,
		'Suggested donation: $0.10 per gram\nScan to pay with your TheLab wallet.',
	);
	// Incomplete donations still name the item, but make no price claim.
	assert.deepEqual(suggest({ link: '', donation: { ...soda, price: '' } }), {
		header: 'Soda',
		body: placeholder.body,
	});
	assert.deepEqual(suggest({ link: '', donation: { ...soda, name: '' } }), generic);
});

test('donation builder encodes fixed-price links', () => {
	assert.deepEqual(donationLink({ ...fixed, name: ' Soda & Snacks ', price: '$1.50' }), {
		href: 'https://thelab.ms/wallet/redeem?n=Soda+%26+Snacks&p=1.50',
		errors: {},
	});
	assert.equal(
		donationLink({ ...fixed, name: 'Gum', price: '.5' }).href,
		'https://thelab.ms/wallet/redeem?n=Gum&p=0.5',
	);
	// Unit details are dropped for fixed prices; the wallet rejects them.
	assert.equal(
		donationLink({ ...fixed, name: 'Soda', price: '2', unit: 'can', min: '1' }).href,
		'https://thelab.ms/wallet/redeem?n=Soda&p=2',
	);
});

test('donation builder encodes per-unit links', () => {
	const filament = { name: 'Filament', price: '0.10', perUnit: true, unit: 'gram', min: '5', max: '2000' };
	assert.deepEqual(donationLink(filament), {
		href: 'https://thelab.ms/wallet/redeem?n=Filament&p=0.10&u=gram&min=5&max=2000',
		errors: {},
	});
	assert.deepEqual(donationLink({ ...filament, price: '0.0025', min: '', max: '' }), {
		href: 'https://thelab.ms/wallet/redeem?n=Filament&p=0.0025&u=gram',
		errors: {},
	});
});

test('donation builder reports invalid fields like the wallet does', () => {
	const errors = (donation: Partial<typeof fixed>) => Object.keys(donationLink({ ...fixed, ...donation }).errors);
	assert.deepEqual(errors({}), ['name', 'price']);
	assert.deepEqual(errors({ name: 'x'.repeat(81), price: '1' }), ['name']);
	assert.deepEqual(errors({ name: 'Bad\u0007', price: '1' }), ['name']);
	for (const price of ['0', '0.00', '0.001', '1.505', '1000', '01', 'free', '-1']) {
		assert.deepEqual(errors({ name: 'Soda', price }), ['price'], price);
	}
	const unit = { name: 'Filament', price: '0.1', perUnit: true, unit: 'gram' };
	assert.deepEqual(errors({ ...unit, price: '0.00001' }), ['price']);
	assert.deepEqual(errors({ ...unit, unit: '' }), ['unit']);
	assert.deepEqual(errors({ ...unit, unit: 'x'.repeat(21) }), ['unit']);
	assert.deepEqual(errors({ ...unit, min: '1.234' }), ['min']);
	assert.deepEqual(errors({ ...unit, max: '100000' }), ['max']);
	assert.deepEqual(errors({ ...unit, min: '10', max: '10' }), ['max']);
	assert.deepEqual(errors({ ...unit, min: '10', max: '9.5' }), ['max']);
});

test('donation links round-trip through the builder fields', () => {
	for (const donation of [
		{ ...fixed, name: 'Soda & Snacks', price: '1.50' },
		{ name: 'Filament', price: '0.10', perUnit: true, unit: 'gram', min: '5', max: '2000' },
		{ name: 'Resin', price: '', perUnit: true, unit: '', min: '', max: '' },
	]) {
		assert.deepEqual(parseDonation(donationLink(donation).href), donation);
	}
	assert.deepEqual(parseDonation('https://thelab.ms/wallet/redeem'), fixed);
	assert.equal(parseDonation('https://thelab.ms/wallet'), undefined);
	assert.equal(parseDonation('https://wiki.thelab.ms/wallet/redeem?n=Soda&p=1'), undefined);
	assert.equal(parseDonation('https://example.com/wallet/redeem?n=Soda&p=1'), undefined);
	assert.equal(parseDonation(''), undefined);
});
