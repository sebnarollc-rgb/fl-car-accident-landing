/* =========================================================
   FL Car Accident Attorney Landing — client-side logic
   - Inline form validation (validate on blur + submit)
   - Async submit to your VPS endpoint with loading + success state
   - Lightweight CTA click tracking hook
   ========================================================= */
(function () {
  "use strict";

  // Current year in footer
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  var form = document.getElementById("leadForm");
  if (!form) return;

  var submitBtn = document.getElementById("submitBtn");
  var successBox = document.getElementById("formSuccess");

  // ---- Validation rules ----
  var validators = {
    name: function (v) { return v.trim().length >= 2 || "Please enter your name."; },
    phone: function (v) {
      var digits = v.replace(/\D/g, "");
      return digits.length >= 10 || "Enter a valid phone number (at least 10 digits).";
    },
    email: function (v) {
      if (!v.trim()) return true; // optional
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "Enter a valid email address.";
    },
    consent: function (_v, el) {
      return el.checked || "Please agree to be contacted so we can help you.";
    }
  };

  function setError(name, message) {
    var field = form.querySelector('[name="' + name + '"]');
    var errEl = form.querySelector('[data-error-for="' + name + '"]');
    if (!field) return;
    if (message === true || message == null) {
      field.removeAttribute("aria-invalid");
      if (errEl) errEl.textContent = "";
    } else {
      field.setAttribute("aria-invalid", "true");
      if (errEl) errEl.textContent = message;
    }
  }

  function validateField(name) {
    var el = form.querySelector('[name="' + name + '"]');
    if (!el || !validators[name]) return true;
    var result = validators[name](el.value, el);
    setError(name, result);
    return result === true;
  }

  // Validate on blur (not on every keystroke)
  ["name", "phone", "email", "consent"].forEach(function (name) {
    var el = form.querySelector('[name="' + name + '"]');
    if (!el) return;
    var evt = el.type === "checkbox" ? "change" : "blur";
    el.addEventListener(evt, function () { validateField(name); });
  });

  // ---- Phone number light formatting (US) ----
  var phoneEl = form.querySelector('[name="phone"]');
  if (phoneEl) {
    phoneEl.addEventListener("input", function () {
      var d = phoneEl.value.replace(/\D/g, "").slice(0, 10);
      if (d.length > 6) phoneEl.value = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
      else if (d.length > 3) phoneEl.value = "(" + d.slice(0, 3) + ") " + d.slice(3);
      else if (d.length > 0) phoneEl.value = "(" + d;
    });
  }

  // ---- Submit ----
  form.addEventListener("submit", function (e) {
    e.preventDefault();

    // Honeypot: if filled, silently drop (bot)
    if (form.querySelector('[name="company"]').value) return;

    var fields = ["name", "phone", "email", "consent"];
    var firstInvalid = null;
    fields.forEach(function (name) {
      var ok = validateField(name);
      if (!ok && !firstInvalid) firstInvalid = form.querySelector('[name="' + name + '"]');
    });

    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    // Loading state
    submitBtn.disabled = true;
    submitBtn.classList.add("is-loading");
    submitBtn.querySelector(".btn__label").textContent = "Sending…";

    var payload = Object.fromEntries(new FormData(form).entries());
    payload.page = location.href;
    payload.submitted_at = new Date().toISOString();

    var action = form.getAttribute("action");

    fetch(action, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json().catch(function () { return {}; });
      })
      .then(function () {
        form.querySelectorAll(".field, .consent, .btn--submit, .form-card__foot").forEach(function (el) {
          el.style.display = "none";
        });
        if (successBox) {
          successBox.hidden = false;
          successBox.focus && successBox.focus();
        }
        track("lead_submit_success");
      })
      .catch(function (err) {
        console.error(err);
        submitBtn.disabled = false;
        submitBtn.classList.remove("is-loading");
        submitBtn.querySelector(".btn__label").textContent = "Get my free case review";
        var errEl = form.querySelector('[data-error-for="consent"]');
        if (errEl) errEl.textContent = "Something went wrong sending your request. Please call [PHONE] and we'll help right away.";
        track("lead_submit_error");
      });
  });

  // ---- Simple CTA tracking hook ----
  // Wire this to GA4 / Google Ads / Meta Pixel as needed.
  function track(event, data) {
    if (window.dataLayer) window.dataLayer.push(Object.assign({ event: event }, data || {}));
    if (window.gtag) window.gtag("event", event, data || {});
  }
  document.querySelectorAll("[data-cta]").forEach(function (el) {
    el.addEventListener("click", function () {
      track("cta_click", { cta: el.getAttribute("data-cta") });
    });
  });
})();
