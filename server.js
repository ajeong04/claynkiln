require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const { appendBookingRow } = require('./sheets');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// ---- Classes (edit prices/names here; amounts are in cents) ----
const CLASSES = [
  { id: 'wheel-throwing-basics', name: 'Wheel Throwing Basics', desc: '4 weeks · Tuesdays 6–8pm', price: 18000 },
  { id: 'hand-building-workshop', name: 'Hand-Building Workshop', desc: 'Single session · Saturday 10am–1pm', price: 6500 },
  { id: 'glazing-finishing', name: 'Glazing & Finishing', desc: '2 weeks · Thursdays 6–8pm', price: 9500 },
  { id: 'date-night-wheel', name: 'Date Night on the Wheel', desc: 'Single session · Friday 7–9:30pm', price: 11000 },
];

// ---- Stripe webhook: MUST use the raw body, so this is registered
// before express.json() touches the request. This is how Stripe lets
// us verify the event really came from Stripe and wasn't forged. ----
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      await appendBookingRow([
        new Date().toISOString(),
        session.metadata.customerName || '',
        session.customer_details?.email || '',
        session.metadata.className || '',
        (session.amount_total / 100).toFixed(2),
        session.payment_method_types?.[0] || '',
        'Paid',
      ]);
      console.log('Booking recorded in Sheet:', session.metadata.className, session.customer_details?.email);
    } catch (err) {
      // Payment succeeded even if the Sheet write failed — never lose that.
      console.error('PAYMENT SUCCEEDED BUT SHEET WRITE FAILED. Follow up manually.', {
        session_id: session.id,
        error: err.message,
      });
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/classes', (req, res) => res.json(CLASSES));

// ---- Start a real Stripe Checkout session (hosted by Stripe — card
// number entry never touches our own server, which is how it should be) ----
app.post('/api/checkout', async (req, res) => {
  try {
    const { classId, name, email } = req.body || {};
    const cls = CLASSES.find((c) => c.id === classId);
    if (!cls) return res.status(400).json({ error: 'Unknown class.' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter your name.' });
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      automatic_payment_methods: { enabled: true },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: cls.name },
            unit_amount: cls.price,
          },
          quantity: 1,
        },
      ],
      customer_email: email,
      metadata: { classId: cls.id, className: cls.name, customerName: name },
      success_url: `${process.env.PUBLIC_URL}/?booked=1`,
      cancel_url: `${process.env.PUBLIC_URL}/?canceled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Something went wrong starting checkout. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Clay & Kiln booking server running on port ${PORT}`));

module.exports = app;
