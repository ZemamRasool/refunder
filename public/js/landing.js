// Landing page waitlist form.
const form = document.getElementById("waitlist");
const msg = document.getElementById("waitlist-msg");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.email.value }),
    });
    const data = await res.json().catch(() => ({}));
    msg.textContent = res.ok ? "You're on the list. We'll email you when your spot opens." : data.error || "Could not join. Try again.";
    if (res.ok) form.reset();
  } catch {
    msg.textContent = "Network problem. Try again.";
  } finally {
    btn.disabled = false;
  }
});
