// Home page navigation. The menu remains a normal link list without JavaScript.
(() => {
	const navbar = document.getElementById('navbar');
	if (!navbar) return;
	const navToggle = /** @type {HTMLElement} */ (document.getElementById('nav-toggle'));
	const navMenu = /** @type {HTMLElement} */ (document.getElementById('nav-menu'));
	const sections = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.section'));
	const sectionLinks = document.querySelectorAll('.nav-link:not(.nav-cta)');
	const heroContent = document.querySelector('.hero-content');
	const mobile = window.matchMedia('(max-width: 767px)');
	navbar.classList.add('nav-ready');

	const handleScroll = () => {
		const pastHeroContent = heroContent
			? heroContent.getBoundingClientRect().bottom <= navbar.getBoundingClientRect().bottom
			: window.scrollY > 50;
		navbar.classList.toggle('scrolled', pastHeroContent);
		const scrollPos = window.scrollY + 120;
		sections.forEach(section => {
			if (scrollPos >= section.offsetTop && scrollPos < section.offsetTop + section.offsetHeight) {
				sectionLinks.forEach(link => {
					link.classList.toggle('active', link.getAttribute('href') === `#${section.id}`);
				});
			}
		});
	};
	window.addEventListener('scroll', handleScroll, { passive: true });
	window.addEventListener('resize', handleScroll);
	handleScroll();

	/** @param {boolean} open */
	function setNav(open) {
		navToggle.classList.toggle('active', open);
		navToggle.setAttribute('aria-expanded', String(open));
		navMenu.classList.toggle('active', open);
		document.body.style.overflow = open ? 'hidden' : '';
	}
	const isOpen = () => navMenu.classList.contains('active');

	navToggle.addEventListener('click', () => {
		setNav(!isOpen());
	});
	document.querySelectorAll('.nav-link').forEach(link => {
		link.addEventListener('click', () => {
			setNav(false);
		});
	});
	document.addEventListener('keydown', e => {
		if (e.key === 'Escape' && isOpen()) {
			setNav(false);
			navToggle.focus();
		}
		if (e.key === 'Tab' && isOpen() && mobile.matches) {
			const links = navMenu.querySelectorAll('a');
			const last = links[links.length - 1];
			if (e.shiftKey && document.activeElement === navToggle && last) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				navToggle.focus();
			}
		}
	});
	document.addEventListener('click', e => {
		const target = /** @type {Node | null} */ (e.target);
		if (isOpen() && !navMenu.contains(target) && !navToggle.contains(target)) setNav(false);
	});

	mobile.addEventListener('change', () => setNav(false));
})();
