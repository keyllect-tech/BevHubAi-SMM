interface ScriptInput {
  productName: string;
  productDescription: string;
  price: string;
  cta: string;
  style: string;
  language: string;
}

export interface GeneratedScript {
  hook: string;
  body: string;
  cta: string;
  fullScript: string;
  scenes: string[];
}

export async function generateScript(input: ScriptInput): Promise<GeneratedScript> {
  const { productName, productDescription, price, cta, style, language } = input;

  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;

  if (apiKey) {
    try {
      console.log("[AI SCRIPT] product:", productName, "language:", language, "style:", style);
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `You are an expert video ad scriptwriter. Create a 15-second script. Language: ${language}. Style: ${style}. 
Output JSON strictly with this schema: 
{ 
  "hook": "0-3s hook text", 
  "scenes": [ 
     { "text": "...", "duration": 4 }, 
     { "text": "...", "duration": 4 }, 
     { "text": "...", "duration": 4 } 
  ], 
  "cta": "final 11-15s cta text", 
  "fullScript": "full text" 
}
Do not invent features not provided. Keep text short and punchy.`,
            },
            {
              role: "user",
              content: `Product: ${productName}. Description: ${productDescription}. Price: ${price}. CTA: ${cta}.`,
            },
          ],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const content = JSON.parse(data.choices[0].message.content);
        console.log("Generated script:\n", content);
        return {
          hook: content.hook,
          body: content.scenes.map((s: { text: string }) => s.text).join(' '),
          cta: content.cta,
          fullScript: content.fullScript,
          scenes: [content.hook, ...content.scenes.map((s: { text: string }) => s.text), content.cta]
        };
      }
    } catch (err) {
      console.error("[AI SCRIPT] Generation failed, using fallback:", err);
    }
  }

  // Fallback
  const name = productName || (language === 'uz' ? 'Mahsulot' : language === 'en' ? 'this product' : 'ваш товар');

  if (language === 'en') {
    const hooks: Record<string, string> = {
      product: `Meet ${name} — the upgrade you've been waiting for.`,
      dynamic: `Stop scrolling. ${name} is about to change everything.`,
      premium: `Introducing ${name}. Crafted for those who expect more.`,
      ugc: `I can't believe I waited this long to try ${name}...`,
    };
    const hook = hooks[style] || hooks.dynamic;
    const bodyText = productDescription
      ? productDescription.slice(0, 180)
      : `Quality you can feel. Design you'll love. ${name} delivers on every promise.`;
    const priceLine = price ? ` Only ${price}.` : '';
    const ctaLine = ` ${cta}!`;
    const body = `${bodyText}.${priceLine}`;
    return {
      hook,
      body,
      cta: ctaLine.trim(),
      fullScript: `${hook} ${body} ${ctaLine.trim()}`,
      scenes: [hook, body, ctaLine.trim()],
    };
  }

  if (language === 'uz') {
    const hooks: Record<string, string> = {
      product: `${name} — siz kutgan yangilanish.`,
      dynamic: `To'xtang! ${name} hamma narsani o'zgartiradi.`,
      premium: `${name}ni taqdim etamiz. Ko'proq kutganlar uchun.`,
      ugc: `${name}ni sinashni shuncha kechiktirdim...`,
    };
    const hook = hooks[style] || hooks.dynamic;
    const bodyText = productDescription
      ? productDescription.slice(0, 180)
      : `Siz his qiladigan sifat. Sevib qolasiz dizayn.`;
    const priceLine = price ? ` Narxi: ${price}.` : '';
    const ctaLine = ` ${cta}!`;
    const body = `${bodyText}.${priceLine}`;
    return {
      hook,
      body,
      cta: ctaLine.trim(),
      fullScript: `${hook} ${body} ${ctaLine.trim()}`,
      scenes: [hook, body, ctaLine.trim()],
    };
  }

  const hooks: Record<string, string> = {
    product: `Знакомьтесь — ${name}. То, что вы искали.`,
    dynamic: `Стоп. ${name} меняет всё.`,
    premium: `Представляем ${name}. Создано для тех, кто выбирает лучшее.`,
    ugc: `Не верю, что так долго не пробовал ${name}...`,
  };
  const hook = hooks[style] || hooks.dynamic;
  const bodyText = productDescription
    ? productDescription.slice(0, 180)
    : `Качество, которое ощущаешь. Дизайн, который любишь. ${name} — оправдывает каждое вложение.`;
  const priceLine = price ? ` Цена: ${price}.` : '';
  const ctaLine = ` ${cta}!`;
  const body = `${bodyText}.${priceLine}`;
  return {
    hook,
    body,
    cta: ctaLine.trim(),
    fullScript: `${hook} ${body} ${ctaLine.trim()}`,
    scenes: [hook, body, ctaLine.trim()],
  };
}
