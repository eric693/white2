/* 功能介紹頁：章節目錄與捲動高亮（無外部相依） */
(function () {
  var doc = document.getElementById('doc');
  var toc = document.getElementById('toc');
  if (!doc || !toc) return;
  var hs = [].slice.call(doc.querySelectorAll('h2'));
  if (!hs.length) { toc.style.display = 'none'; return; }

  var lab = document.createElement('div');
  lab.className = 'toc-label';
  lab.textContent = '章節';
  toc.appendChild(lab);

  var links = hs.map(function (h, n) {
    h.id = 'sec-' + n;
    var a = document.createElement('a');
    a.href = '#sec-' + n;
    a.textContent = h.textContent;
    toc.appendChild(a);
    return a;
  });

  if (!('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      var i = hs.indexOf(e.target);
      links.forEach(function (a, n) { a.classList.toggle('on', n === i); });
    });
  }, { rootMargin: '0px 0px -75% 0px' });
  hs.forEach(function (h) { io.observe(h); });
})();
