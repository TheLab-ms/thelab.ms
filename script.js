/* ============================================
   TheLab - script.js
   Mobile nav, sticky navbar, scroll animations,
   and contact form handling
   ============================================ */

(function () {
  'use strict';

  // ---- DOM Elements ----
  const navbar    = document.getElementById('navbar');
  const navToggle = document.getElementById('nav-toggle');
  const navMenu   = document.getElementById('nav-menu');
  const navLinks  = document.querySelectorAll('.nav-link');
  const fadeEls   = document.querySelectorAll('.fade-in');

  // ---- Sticky Navbar on Scroll ----
  let lastScroll = 0;

  function handleScroll() {
    const scrollY = window.scrollY;

    // Add/remove "scrolled" class for background
    if (scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }

    lastScroll = scrollY;
  }

  window.addEventListener('scroll', handleScroll, { passive: true });
  // Run once on load in case the page is already scrolled
  handleScroll();

  // ---- Mobile Nav Toggle ----
  function openNav() {
    navToggle.classList.add('active');
    navToggle.setAttribute('aria-expanded', 'true');
    navMenu.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeNav() {
    navToggle.classList.remove('active');
    navToggle.setAttribute('aria-expanded', 'false');
    navMenu.classList.remove('active');
    document.body.style.overflow = '';
  }

  navToggle.addEventListener('click', function () {
    const isOpen = navMenu.classList.contains('active');
    if (isOpen) {
      closeNav();
    } else {
      openNav();
    }
  });

  // Close mobile nav when a link is clicked
  navLinks.forEach(function (link) {
    link.addEventListener('click', function () {
      if (navMenu.classList.contains('active')) {
        closeNav();
      }
    });
  });

  // Close mobile nav on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && navMenu.classList.contains('active')) {
      closeNav();
      navToggle.focus();
    }
  });

  // Close mobile nav when clicking outside
  document.addEventListener('click', function (e) {
    if (
      navMenu.classList.contains('active') &&
      !navMenu.contains(e.target) &&
      !navToggle.contains(e.target)
    ) {
      closeNav();
    }
  });

  // ---- Active Nav Link Highlight on Scroll ----
  const sections = document.querySelectorAll('.section');
  const navLinkItems = document.querySelectorAll('.nav-link:not(.nav-cta)');

  function highlightNavLink() {
    const scrollPos = window.scrollY + 120;

    sections.forEach(function (section) {
      const top = section.offsetTop;
      const bottom = top + section.offsetHeight;
      const id = section.getAttribute('id');

      if (scrollPos >= top && scrollPos < bottom) {
        navLinkItems.forEach(function (link) {
          link.classList.remove('active');
          if (link.getAttribute('href') === '#' + id) {
            link.classList.add('active');
          }
        });
      }
    });
  }

  window.addEventListener('scroll', highlightNavLink, { passive: true });

  // ---- Intersection Observer for Fade-In Animations ----
  if ('IntersectionObserver' in window) {
    const fadeObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            fadeObserver.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.15,
        rootMargin: '0px 0px -40px 0px',
      }
    );

    fadeEls.forEach(function (el) {
      fadeObserver.observe(el);
    });
  } else {
    // Fallback: just show everything
    fadeEls.forEach(function (el) {
      el.classList.add('visible');
    });
  }

  // ---- Staggered Fade-In for Grid Items ----
  // Add a small delay to each card in a grid for a cascading effect
  document.querySelectorAll('.shops-grid .shop-card').forEach(function (card, i) {
    card.style.transitionDelay = (i * 0.08) + 's';
  });

  // ---- Smooth Scroll for anchor links (fallback for older browsers) ----
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var targetId = this.getAttribute('href');
      if (targetId === '#') return;

      var target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        var offsetTop = target.offsetTop - 70;
        window.scrollTo({
          top: offsetTop,
          behavior: 'smooth',
        });
      }
    });
  });

})();
