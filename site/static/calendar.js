/* Google supplies events; our Worker supplies cached, expanded occurrences. */
(function () {
  'use strict';
  const root = document.getElementById('calendar');
  if (!root) return;
  const get = id => document.getElementById(`calendar-${id}`);
  const content = get('content'), status = get('status'), dialog = get('dialog');
  const zone = 'America/Chicago';
  const format = (date, options) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }).format(new Date(date));
  const dayKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
  const today = () => dayKey(new Date());
  const shiftMonth = (month, n) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + n, 1)).toISOString().slice(0, 7);
  const dateLabel = date => format(`${date}T12:00:00Z`, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const clock = date => format(date, { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  let month = today().slice(0, 7), view = 'month', data = null, controller, lastTrigger;
  let min = shiftMonth(month, -1), max = shiftMonth(month, 12);

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function eventDays(event) {
    const start = event.allDay ? event.start : dayKey(event.start);
    // DTEND is exclusive, including for all-day events.
    const end = event.allDay ? new Date(`${event.end}T00:00:00Z`).getTime() - 1 : Math.max(new Date(event.start).getTime(), new Date(event.end).getTime() - 1);
    const last = event.allDay ? new Date(end).toISOString().slice(0, 10) : dayKey(end);
    return { start, last };
  }
  function eventsOn(date) {
    return data.events.filter(event => {
      const { start, last } = eventDays(event);
      return date >= start && date <= last;
    }).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  }
  function eventButton(event, date) {
    const button = node('button', 'calendar-event');
    button.type = 'button';
    const when = event.allDay ? 'All day' : eventDays(event).start < date ? 'Continues' : clock(event.start);
    button.append(node('span', 'calendar-event-time', when), node('span', 'calendar-event-title', event.title));
    button.setAttribute('aria-label', `${event.title}, ${dateLabel(date)}, ${when}, Central time. View details`);
    button.addEventListener('click', () => showEvent(event, button));
    return button;
  }
  function openDialog(title, body, trigger) {
    if (!dialog.open) lastTrigger = trigger;
    get('dialog-title').textContent = title;
    get('dialog-body').replaceChildren(body);
    dialog.showModal();
  }
  function showEvent(event, trigger) {
    const body = node('div');
    const detail = (label, text) => {
      const p = node('p', 'calendar-detail');
      p.append(node('span', 'calendar-detail-label', label), node('span', '', text));
      body.append(p);
    };
    const { start, last } = eventDays(event);
    const dates = dateLabel(start) + (last !== start ? ` – ${dateLabel(last)}` : '');
    detail('When', `${dates}\n${event.allDay ? 'All day' : `${clock(event.start)} – ${clock(event.end)} Central`}`);
    if (event.location) detail('Where', event.location);
    if (event.description) {
      // Calendar descriptions can contain HTML. Convert it to inert plain text.
      const parsed = new DOMParser().parseFromString(event.description.replace(/<br\s*\/?\s*>/gi, '\n'), 'text/html');
      parsed.querySelectorAll('script, style').forEach(element => element.remove());
      body.append(node('p', 'calendar-description', parsed.body.textContent));
    }
    openDialog(event.title, body, trigger);
  }
  function render() {
    if (!data) return;
    const grid = node('table', 'calendar-table');
    grid.setAttribute('aria-label', format(`${month}-01T12:00:00Z`, { month: 'long', year: 'numeric' }));
    const head = node('thead'), row = node('tr');
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => { const th = node('th', '', day); th.scope = 'col'; row.append(th); });
    head.append(row); grid.append(head);
    const body = node('tbody'), agenda = node('div', 'calendar-agenda');
    const start = new Date(`${data.gridStart}T12:00:00Z`);
    let monthEvents = 0;
    for (let week = 0; week < 6; week++) {
      const tr = node('tr');
      for (let day = 0; day < 7; day++) {
        const date = new Date(start); date.setUTCDate(start.getUTCDate() + week * 7 + day);
        const key = date.toISOString().slice(0, 10), events = eventsOn(key);
        const td = node('td', `calendar-day${key.slice(0, 7) !== month ? ' calendar-day--outside' : ''}${key === today() ? ' calendar-day--today' : ''}`);
        const time = node('time', 'calendar-date', String(date.getUTCDate()));
        time.dateTime = key; time.setAttribute('aria-label', dateLabel(key));
        if (key === today()) time.setAttribute('aria-current', 'date');
        td.append(time);
        events.slice(0, 2).forEach(event => td.append(eventButton(event, key)));
        if (events.length > 2) {
          const more = node('button', 'calendar-more', `+${events.length - 2} more`);
          more.type = 'button'; more.setAttribute('aria-label', `All ${events.length} events for ${dateLabel(key)}`);
          more.addEventListener('click', () => {
            const list = node('div', 'calendar-agenda');
            events.forEach(event => list.append(eventButton(event, key)));
            openDialog(dateLabel(key), list, more);
          });
          td.append(more);
        }
        tr.append(td);
        if (key.slice(0, 7) === month && events.length) {
          monthEvents += events.length;
          const group = node('section', 'calendar-agenda-day');
          group.append(node('h4', '', dateLabel(key)));
          events.forEach(event => group.append(eventButton(event, key)));
          agenda.append(group);
        }
      }
      body.append(tr);
    }
    grid.append(body);
    if (!monthEvents) agenda.append(node('p', 'calendar-notice', 'No events scheduled this month. Check another month or visit our Discord to connect with the community.'));
    content.replaceChildren(view === 'month' ? grid : agenda);
    get('month-view').setAttribute('aria-pressed', String(view === 'month'));
    get('list-view').setAttribute('aria-pressed', String(view === 'list'));
    status.textContent = data.stale ? 'Showing previously updated events. Google Calendar is temporarily unavailable.' : monthEvents ? 'Select an event for details.' : 'No events scheduled this month.';
  }
  function updateControls(loading) {
    get('prev').disabled = loading || month <= min;
    get('next').disabled = loading || month >= max;
    get('today').disabled = loading || month === today().slice(0, 7);
  }
  async function load() {
    controller?.abort(); controller = new AbortController();
    const active = controller;
    data = null;
    content.replaceChildren(); content.setAttribute('aria-busy', 'true');
    get('month').textContent = format(`${month}-01T12:00:00Z`, { month: 'long', year: 'numeric' });
    status.textContent = 'Loading events…'; get('retry').hidden = true; updateControls(true);
    const timeout = setTimeout(() => active.abort(), 15000);
    try {
      const response = await fetch(`/calendar/data?month=${month}`, { signal: active.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Calendar unavailable');
      const result = await response.json();
      if (controller !== active) return;
      data = result; min = data.min; max = data.max; render();
    } catch {
      if (controller !== active) return;
      status.textContent = 'Events are temporarily unavailable. Try again or open Google Calendar below.';
      get('retry').hidden = false;
    } finally {
      clearTimeout(timeout);
      if (controller === active) { content.setAttribute('aria-busy', 'false'); updateControls(false); }
    }
  }
  get('prev').addEventListener('click', () => { month = shiftMonth(month, -1); load(); });
  get('next').addEventListener('click', () => { month = shiftMonth(month, 1); load(); });
  get('today').addEventListener('click', () => { month = today().slice(0, 7); load(); });
  get('retry').addEventListener('click', load);
  ['month', 'list'].forEach(name => get(`${name}-view`).addEventListener('click', () => { view = name; render(); }));
  dialog.addEventListener('close', () => { if (lastTrigger?.isConnected) lastTrigger.focus(); });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  // Load when the section approaches the viewport, rather than during hero load.
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: '400px' });
    observer.observe(root);
  } else load();
})();
