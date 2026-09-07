/**
 * Job-description drafting.
 *
 * ---------------------------------------------------------------------------
 * This is a TEMPLATE, and the reference's is too
 * ---------------------------------------------------------------------------
 * The reference calls this "AI-assisted JD drafting" and its own header says
 * the LLM call is a stub: `ai-jd.service.ts` renders a string template and
 * makes no network request of any kind. Naming it `ai` here would promise the
 * user something the code does not do — a drafting aid that fills in the shape
 * of a description is genuinely useful, and calling it what it is costs
 * nothing.
 *
 * Pure and synchronous: no network, no key, no clock. Swapping in a real model
 * later is a change behind this function's signature.
 *
 * The company name comes from CompanyProfile at the call site rather than being
 * baked in — the reference hardcodes "D-Table Analytics" into the generated
 * prose, which is exactly the customer-specific value AD-1 moved into the
 * company profile.
 */

import { AI_JD_SENIORITIES } from '../../../shared/constants/hiring.js';

/** Rough experience bands, matching the reference's. */
const YEARS_BY_SENIORITY = Object.freeze({
  junior: '0-2 years',
  mid: '3-5 years',
  senior: '6-9 years',
  lead: '10+ years',
});

const SENIORITY_FOCUS = Object.freeze({
  junior: 'learn quickly, ask good questions, and take ownership of well-scoped work',
  mid: 'take a problem end to end and communicate clearly along the way',
  senior: 'navigate ambiguity, set technical direction, and raise the bar for those around you',
  lead: 'set direction, grow the people around you, and be accountable for outcomes rather than output',
});

/**
 * Draft a description and a requirements list.
 *
 * @param {object} input                validated by `generateJdSchema`
 * @param {string} [companyName]        resolved from CompanyProfile by the caller
 * @returns {{ description: string, requirements: string }}
 */
export function generateJobDescription(input, companyName = 'our team') {
  const seniority = AI_JD_SENIORITIES.includes(input.seniority) ? input.seniority : 'mid';
  const years = YEARS_BY_SENIORITY[seniority];
  const focus = SENIORITY_FOCUS[seniority];
  const skills = input.skills.filter(Boolean);

  const description = [
    `About the role`,
    ``,
    `We are hiring a ${input.title} to join ${companyName}. In this ${seniority} role you will`,
    `${focus}.`,
    ``,
    `You will work alongside colleagues across the business on problems where clear`,
    `thinking, dependable delivery and a strong sense of ownership matter more than`,
    `any particular tool.`,
    ``,
    `What you will do`,
    ``,
    `- Own a meaningful slice of the work end to end, from problem to production`,
    `- Work closely with the people who depend on what you build`,
    `- Leave things better documented and better understood than you found them`,
  ].join('\n');

  const requirements = [
    `What we are looking for`,
    ``,
    `- ${years} of relevant experience`,
    ...skills.map((skill) => `- Strong, hands-on experience with ${skill}`),
    `- Clear written and spoken communication`,
    `- A track record of finishing what you start`,
    ``,
    `Nice to have`,
    ``,
    `- Experience in a comparable industry or a company of a similar size`,
    // Stated explicitly, because a requirements list that reads as a checklist
    // filters out good applicants who self-select away from it.
    `- We do not expect every point above; tell us what you do bring`,
  ].join('\n');

  return { description, requirements };
}

export default { generateJobDescription };
