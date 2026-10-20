// Home page: sticky navbar, mobile navigation, active section links, and hero fade-in.
(function () {
  'use strict';
  const navbar = document.getElementById('navbar');
  if (!navbar) return;
  const navToggle = /** @type {HTMLElement} */ (document.getElementById('nav-toggle'));
  const navMenu = /** @type {HTMLElement} */ (document.getElementById('nav-menu'));
  const sections = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.section'));
  const sectionLinks = document.querySelectorAll('.nav-link:not(.nav-cta)');

  const handleScroll = function () {
    navbar.classList.toggle('scrolled', window.scrollY > 50);
    const scrollPos = window.scrollY + 120;
    sections.forEach(function (section) {
      if (scrollPos >= section.offsetTop && scrollPos < section.offsetTop + section.offsetHeight) {
        sectionLinks.forEach(function (link) {
          link.classList.toggle('active', link.getAttribute('href') === '#' + section.id);
        });
      }
    });
  };
  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();

  /** @param {boolean} open */
  function setNav(open) {
    navToggle.classList.toggle('active', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navMenu.classList.toggle('active', open);
    document.body.style.overflow = open ? 'hidden' : '';
  }
  const isOpen = function () { return navMenu.classList.contains('active'); };

  navToggle.addEventListener('click', function () { setNav(!isOpen()); });
  document.querySelectorAll('.nav-link').forEach(function (link) {
    link.addEventListener('click', function () { setNav(false); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) {
      setNav(false);
      navToggle.focus();
    }
  });
  document.addEventListener('click', function (e) {
    const target = /** @type {Node | null} */ (e.target);
    if (isOpen() && !navMenu.contains(target) && !navToggle.contains(target)) setNav(false);
  });

  // Reveal the browser-selected responsive hero image, including cached loads.
  const heroBg = document.querySelector('.hero-bg');
  const heroImage = heroBg && heroBg.querySelector('img');
  if (heroBg && heroImage) {
    const revealHero = function () { heroBg.classList.add('loaded'); };
    heroImage.addEventListener('load', revealHero, { once: true });
    heroImage.addEventListener('error', revealHero, { once: true });
    if (heroImage.complete) revealHero();
  }
})();
