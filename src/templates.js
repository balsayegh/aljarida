/**
 * Arabic message templates for all outbound messages.
 *
 * Keeping all user-facing text in one file makes it easy to:
 *   - Review wording with the editorial team
 *   - Adjust messaging without touching business logic
 *   - Add English translations later
 *
 * NOTE: The daily delivery message is NOT here — it uses a Meta-approved
 * template submitted separately via the Business Manager. That happens in Piece 3.
 */

export const messages = {
  offer: `أهلاً بك في جريدة الجريدة 📰

نقدّم خدمة استلام العدد اليومي الكامل (PDF) على واتساب.

📅 من الأحد إلى الجمعة
🕕 كل صباح
💰 2.5 د.ك / شهرياً

هل تودّ الاشتراك؟`,

  paymentPrompt: `رائع! 🎉

للاشتراك، يُرجى إتمام الدفع عبر الرابط الآمن أدناه:

[رابط الدفع سيظهر هنا قريباً]

بعد إتمام الدفع، سيصلك العدد الأول في أول يوم إصدار.

💳 الدفع عبر K-Net, Visa, Mastercard
🔒 دفع آمن 100%`,

  paymentReminder: `يبدو أنك لم تُكمل عملية الاشتراك بعد.

يمكنك المتابعة الآن:`,

  noResponse: `لا بأس! 🌷

إذا غيّرت رأيك لاحقاً، فقط أرسل لنا أي رسالة ونحن هنا.

شكراً لاهتمامك بجريدة الجريدة.`,

  optOutConfirmation: `تم إلغاء اشتراكك بنجاح ✓

لن تصلك أي رسائل بعد الآن.

إذا كان هناك أي ملاحظات تودّ مشاركتنا إياها، يسعدنا سماعها.

شكراً لك.`,

  pleaseUseButtons: `يُرجى الضغط على أحد الأزرار أدناه:`,

  activeAck: `شكراً لتواصلك! 🌷

سيصلك العدد اليومي في الصباح كالمعتاد.

إذا كنت بحاجة إلى مساعدة، يُرجى التواصل معنا.`,

  welcomeAfterPayment: `تم تفعيل اشتراكك بنجاح! ✓

ستبدأ باستلام العدد اليومي الكامل في أول يوم إصدار الساعة الصباح الباكر.

للإلغاء في أي وقت، أرسل "إيقاف".

شكراً لاختيارك جريدة الجريدة 📰`,
};
