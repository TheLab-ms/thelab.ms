import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('../../static/event-form.js', import.meta.url), 'utf8');

function browser(startValue: string, ordinal?: number) {
	const original = { value: startValue },
		position = ordinal === undefined ? null : { value: String(ordinal) };
	const start = Object.assign(new EventTarget(), {
		value: startValue,
		form: {
			querySelector(selector: string) {
				return selector === '[name="ordinal"]' ? position : position ? original : null;
			},
		},
	});
	const options = [
		{ value: 'none', textContent: 'Does not repeat' },
		{ value: 'weekly', textContent: '' },
		{ value: 'ordinal', textContent: '' },
	];
	const repeat = { options, value: 'ordinal' };
	vm.runInNewContext(script, {
		document: { getElementById: (id: string) => (id === 'event-start' ? start : repeat) },
		Date,
		Intl,
	});
	return {
		start,
		repeat,
		options,
		change(value: string) {
			start.value = value;
			start.dispatchEvent(new Event('input'));
		},
	};
}

test('updates recurrence labels to match the start date without changing the selected pattern', () => {
	const b = browser('2027-01-05T19:00');
	assert.equal(b.options[1]!.textContent, 'Every Tuesday');
	assert.equal(b.options[2]!.textContent, 'The first Tuesday of every month');
	b.change('2027-01-09T19:00');
	assert.equal(b.options[1]!.textContent, 'Every Saturday');
	assert.equal(b.options[2]!.textContent, 'The second Saturday of every month');
	b.change('2027-01-30T19:00');
	assert.equal(b.options[2]!.textContent, 'The last Saturday of every month');
	assert.equal(b.repeat.value, 'ordinal');
	assert.equal(b.options[0]!.textContent, 'Does not repeat');
	b.change('');
	assert.equal(b.options[2]!.textContent, 'The last Saturday of every month');
});

test('retains an existing last-weekday position for time changes and recalculates it for date changes', () => {
	const b = browser('2027-02-27T19:00', -1);
	assert.equal(b.options[2]!.textContent, 'The last Saturday of every month');
	b.change('2027-02-27T20:00');
	assert.equal(b.options[2]!.textContent, 'The last Saturday of every month');
	b.change('2027-03-13T19:00');
	assert.equal(b.options[2]!.textContent, 'The second Saturday of every month');
});
