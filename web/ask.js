/* Questions use server evidence; identifiers stay strings throughout. */
(() => {
  'use strict';
  function init() {
    const form = document.getElementById('ask-form');
    const input = document.getElementById('ask-question');
    const submit = document.getElementById('ask-submit');
    const answer = document.getElementById('ask-answer');
    if (!form || !input || !submit || !answer) return;
    let pending = false;
    const storageKey = 'zhetysu-investigation-question';
    const idleLabel = submit.textContent;
    try { input.value = (sessionStorage.getItem(storageKey) || '').slice(0, 1000); } catch (_) {}
    input.addEventListener('input', () => {
      try { sessionStorage.setItem(storageKey, input.value.slice(0, 1000)); } catch (_) {}
    });
    function message(text, error = false) {
      answer.replaceChildren();
      answer.textContent = text;
      answer.dataset.state = error ? 'error' : 'ready';
    }
    function render(result) {
      answer.replaceChildren();
      answer.dataset.state = 'ready';
      const text = document.createElement('p');
      text.className = 'ask-response';
      text.style.whiteSpace = 'pre-wrap';
      text.style.overflowWrap = 'anywhere';
      text.textContent = result.answer;
      answer.append(text);
      const ids = [...new Set(result.nodes)].filter(id => typeof id === 'string' && byId.has(id));
      if (ids.length) {
        const links = document.createElement('div');
        links.className = 'ask-clients';
        links.setAttribute('aria-label', 'Клиенты из ответа');
        for (const id of ids) {
          const link = document.createElement('button');
          link.type = 'button';
          link.className = 'ask-client';
          link.dataset.gid = id;
          link.textContent = id;
          link.setAttribute('aria-label', 'Открыть досье клиента ' + id);
          link.style.overflowWrap = 'anywhere';
          links.append(link);
        }
        answer.append(links);
      }
      const provenance = document.createElement('p');
      provenance.className = 'ask-source';
      provenance.textContent = (typeof result.source === 'string' && result.source.trim()
        ? 'Основание: ' + result.source + '. ' : '') + 'Ответ описывает признаки для проверки, а не устанавливает виновность.';
      answer.append(provenance);
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending) return;
      const q = input.value.trim();
      if (!q) { message('Напишите вопрос по сети. Например: «Кого смотреть первым?»', true); input.focus(); return; }
      if (q.length > 1000) { message('Сократите вопрос до 1000 символов.', true); input.focus(); return; }
      pending = true;
      submit.disabled = true;
      submit.textContent = 'Ищем в данных…';
      answer.setAttribute('aria-busy', 'true');
      message('Проверяем связи и основания в выгрузке…');
      answer.dataset.state = 'loading';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch('/api/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q }), signal: controller.signal,
        });
        if (!response.ok) {
          message(response.status === 503
            ? 'Выгрузка временно недоступна. Вопрос сохранён — повторите запрос позже.'
            : 'Сервис не смог обработать вопрос. Повторите запрос или откройте клиента по gid.', true);
          return;
        }
        let result;
        try { result = await response.json(); } catch (_) {
          message('Сервис вернул нечитаемый ответ. Повторите запрос; вопрос сохранён.', true); return;
        }
        if (!result || typeof result.answer !== 'string' || !Array.isArray(result.nodes)) {
          message('Ответ пришёл в неожиданном формате. Повторите запрос; вопрос сохранён.', true); return;
        }
        if (!result.answer.trim()) {
          message('В выгрузке не найден ответ. Уточните вопрос или укажите полный gid клиента.'); return;
        }
        render(result);
      } catch (error) {
        message(error.name === 'AbortError'
          ? 'Ответ не пришёл за 30 секунд. Вопрос сохранён — попробуйте ещё раз.'
          : 'Нет связи с сервисом вопросов. Вопрос сохранён. Загруженную сеть можно продолжать исследовать.', true);
      } finally {
        clearTimeout(timeout);
        pending = false;
        submit.disabled = false;
        submit.textContent = idleLabel;
        answer.setAttribute('aria-busy', 'false');
      }
    });
    if (!answer.textContent.trim()) message('Спросите о клиенте, его связях или основаниях приоритета. Например: «Кого смотреть первым?»');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
