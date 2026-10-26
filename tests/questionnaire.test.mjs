import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'Inline application script is present');
assert.doesNotThrow(() => new Function(script), 'Application JavaScript parses');
const bootstrapEnd = script.lastIndexOf("$('nav-toggle').addEventListener");
assert.ok(bootstrapEnd > 0, 'Startup marker is present');
const model = script.slice(0, bootstrapEnd);

function app(answers = {}) {
  const state = new Function('document', 'window', model + `
return {
  config: CONFIG, common: COMMON, formData: FORM_VALUES,
  setAnswer, ineligibleReason, formSections, evaluate, isValidField,
  questionMarkup, get, setForm: form => { ACTIVE_FORM = form; }
};`)({ getElementById: () => null }, { scrollTo: () => {} });
  Object.assign(state.common, {
    stage: 'new', goal: 'business', founders: '1',
    founder_types: ['individuals'], profits: 'keep',
    paid: 'no', customers: ['public'], legal_risks: ['none'],
    ...answers
  });
  return state;
}
const allQuestions = app().config.sections.flatMap(section => section.questions);
const question = id => {
  const item = allQuestions.find(q => q.id === id);
  assert.ok(item, 'Question exists: ' + id);
  return item;
};

test('questionnaire metadata and legal references are consistent', () => {
  const config = app().config;
  const ids = allQuestions.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length, 'Question IDs are unique');
  const validateCondition = (rule, target) => {
    if (!rule) return;
    for (const part of [...(rule.all || []), ...(rule.any || [])]) validateCondition(part, target);
    if (rule.id) assert.ok(ids.includes(rule.id) || rule.id === 'founders_form', target + ': referenced question exists (' + rule.id + ')');
    if (rule.answerNot) assert.ok(ids.includes(rule.answerNot.id), target + ': answerNot question exists');
  };
  for (const section of config.sections) {
    validateCondition(section.when, section.id);
    for (const q of section.questions) {
      validateCondition(q.when, q.id);
      for (const ref of q.source || []) assert.ok(config.refs[ref], q.id + ': legal citation ' + ref);
      if (q.type === 'radio' || q.type === 'multi') {
        assert.ok(q.options.length > 0);
        assert.equal(new Set(q.options.map(o => o.value)).size, q.options.length);
      }
    }
  }
});

test('print and Markdown are the only result exports', () => {
  for (const oldId of ['quick-json', 'export-json', 'import-json', 'clear', 'upload', 'print-bottom'])
    assert.doesNotMatch(html, new RegExp('id="' + oldId + '"'));
  assert.match(html, /id="print"/);
  assert.match(html, /id="export-md"/);
});

test('association needs two founders; one-person LLC is allowed', () => {
  const state = app();
  assert.match(state.ineligibleReason('association'), /двух/);
  assert.equal(state.ineligibleReason('ooo'), '');
});

test('public association needs three individual founders', () => {
  const state = app({founders: '2', goal: 'civic'});
  assert.match(state.ineligibleReason('public_org'), /тр[её]м/);
});

test('one-member LLC has no irrelevant general-meeting procedures', () => {
  const state = app();
  state.setAnswer('form_select', ['ooo']);
  state.setForm('ooo');
  const ids = state.formSections('ooo').flatMap(s => s.visible.map(q => q.id));
  assert.ok(ids.includes('llc_certify'));
  for (const id of ['meeting_notice', 'meeting_quorum', 'notices', 'absentee'])
    assert.ok(!ids.includes(id), 'No meeting-only question: ' + id);
});

test('two-member LLC can specify meeting rules', () => {
  const state = app({founders: '2'});
  state.setAnswer('form_select', ['ooo']);
  state.setForm('ooo');
  assert.ok(state.formSections('ooo').flatMap(s => s.visible).some(q => q.id === 'meeting_notice'));
});

test('IP has no charter questions even with two selected legal forms', () => {
  const state = app({goal:'mixed', founders:'1'});
  state.setAnswer('form_select', ['ip', 'ooo']);
  state.setForm('ip');
  assert.deepEqual(state.formSections('ip'), []);
  assert.ok(!state.evaluate().missing.some(q => q.id === 'charter_founders'));
});

test('association delegate conference is unavailable with at most 100 members', () => {
  const state = app({founders:'2',goal:'members'});
  state.setAnswer('form_select',['association']);
  state.setForm('association');
  assert.match(state.questionMarkup(question('assoc_top')), /Недоступно: Съезд/);
  state.setAnswer('assoc_future_count', 'over100');
  assert.doesNotMatch(state.questionMarkup(question('assoc_top')), /Недоступно: Съезд/);
});

test('non-compliant public association founders produce a blocking issue', () => {
  const state = app({founders:'3to50',founder_types:['individuals'],goal:'civic',public_three:'yes'});
  state.setAnswer('form_select',['public_org']);
  state.setForm('public_org');
  state.setAnswer('public_founder_eligibility','no');
  assert.ok(state.evaluate().blocking.some(note => note.includes('статье 19')));
});

test('all-Russian union cannot choose absence of regional subdivisions', () => {
  const state = app({founders:'3to50',founder_types:['individuals'],goal:'civic',public_three:'yes'});
  state.setAnswer('form_select',['public_org']);
  state.setForm('public_org');
  state.setAnswer('public_territory','allrussia');
  assert.match(state.questionMarkup(question('public_structure')), /Недоступно: Для этого статуса/);
});

test('mixed IP and NPO revenues are not automatically treated as NPO dividends', () => {
  const state = app({goal:'mixed',profits:'distribute'});
  state.setAnswer('form_select',['ano','ip']);
  state.setForm('ano');
  assert.ok(state.evaluate().cautions.some(x => x.includes('ООО или ИП')));
  assert.ok(!state.evaluate().blocking.some(x => x.includes('доход от участия')));
});

test('single paid NPO must specify an income source', () => {
  const state = app({goal:'services',paid:'main'});
  state.setAnswer('form_select',['ano']);
  state.setForm('ano');
  assert.ok(state.evaluate().blocking.some(x => x.includes('не отмечен')));
});

test('consumer cooperative has review warning, not unconditional impossibility', () => {
  const state = app({goal:'mutual',founders:'2'});
  state.setAnswer('form_select',['coop']);
  state.setForm('coop');
  assert.ok(state.evaluate().cautions.some(x => x.includes('специального закона')));
  assert.ok(!state.evaluate().blocking.some(x => x.includes('готовность к регистрации')));
});

test('bare legal-form name is not sufficient', () => {
  const state = app({goal:'charity'});
  state.setAnswer('form_select',['fund']);
  state.setForm('fund');
  state.setAnswer('full_name','Фонд');
  assert.equal(state.isValidField(question('full_name')),false);
  state.setAnswer('full_name','Общественно полезный фонд «Маяк»');
  assert.equal(state.isValidField(question('full_name')),true);
});

test('foreign status alone does not identify the founder category', () => {
  const state = app({founder_types:['foreign']});
  assert.equal(state.isValidField(question('founder_types')),false);
});
