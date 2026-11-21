// The prompt sent to every chat-style AI provider. Kept in one place so OpenAI-compatible servers,
// Ollama and any future provider all ask for exactly the same thing.

import { CATEGORY_LABELS } from '../content.js';
import { LANGUAGES } from '../lang.js';

export function scriptPrompt(
  { productName, description, cta, language, style, category },
  { includeFullText = false, strictFacts = true } = {},
) {
  const langLabel = LANGUAGES[language] + (language === 'uz' ? ' (Uzbek Latin alphabet, use ʻ in oʻ and gʻ)' : '');
  const responseShape = includeFullText
    ? '{"hook":"...","benefit1":"...","benefit2":"...","cta":"...","fullText":"..."}'
    : '{"hook":"...","benefit1":"...","benefit2":"...","cta":"..."}';
  const factualityInstructions = strictFacts
    ? `\nUse the title and description as the only evidence for product properties. Use only properties explicitly stated there. Do not invent speed, quality, functions, runtime, dates, guarantees, compatibility, included items, materials, or other properties. Do not infer anything from the product category or technology. Do not strengthen, weaken, or reverse numeric ranges or negations. For example, “Bluetooth headphones” alone does not establish instant pairing, one-button pairing, phone compatibility, battery life, or sound quality. If evidence is sparse, write neutral ad copy without unsupported benefits. The CTA may invite the user to act, but must not promise an unverified result.`
    : '';
  const system = `You write scripts for 15-second vertical video ads (TikTok, Reels, Shorts).
Ad type: ${CATEGORY_LABELS[category] || CATEGORY_LABELS.other}. Visual style: ${style}.
Write every field ONLY in ${langLabel}.
Return ONLY valid JSON with exactly these keys: ${responseShape}
- hook (0-3 s): a short attention-grabbing opening, at most 7 words
- benefit1 (3-8 s): the strongest point from the description, at most 10 words
- benefit2 (8-12 s): a second, different point from the description, at most 10 words
- cta (12-15 s): the call to action, based on the user's call to action, at most 5 words${includeFullText
    ? '\n- fullText: one complete ad text containing the four fields in order; repeat each field verbatim'
    : ''}
Rules: rewrite the user's words into catchy ad copy; use only facts from the title and description;
never invent prices, numbers, reviews, guarantees or deadlines; no emojis, hashtags or quotation marks.${factualityInstructions}
Never mix languages: if the description is written in another language, translate its facts into ${langLabel}.`;
  const user = `Title: ${productName}\nDescription: ${description}\nCall to action: ${cta}`;
  return { system, user };
}