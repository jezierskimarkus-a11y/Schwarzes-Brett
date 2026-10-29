(() => {
      "use strict";
      const $ = (id) => document.getElementById(id);
      const allowedColors = ["yellow","lavender","mint","rose","blue"];
      const allowedCategories = ["Allgemein","Termine","Fragen","Angebote"];
      const baseUrl = String(BOARD_CONFIG.supabaseUrl || "").trim().replace(/\/+$/, "");
      const sharedMode = Boolean(baseUrl);
      const storageKey = "schwarzes-brett-notes-v1";
      // Browser-ID nur fuer die unvernetzte Demo; Online-Bewertungen sind JWT-gebunden.
      const voterKey = "schwarzes-brett-voter-v1";
      let voterId = localStorage.getItem(voterKey);
      if (!voterId || !/^[0-9a-f-]{36}$/i.test(voterId)) {voterId=crypto.randomUUID();localStorage.setItem(voterKey,voterId);}
      const sb = sharedMode && window.supabase?.createClient
        ? window.supabase.createClient(baseUrl,BOARD_CONFIG.supabasePublishableKey,{
            auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}
          }) : null;
      let hasAccess = false;
      let isAdmin = false;
      let activeUserId = null;
      let removedImagePaths = new Set();
      let removeAvatarPending = false;
      const ratings = new Map();
      const nameKey = "schwarzes-brett-name-v1";
      const tokenKey = "schwarzes-brett-access-token";
      const fragmentToken = new URLSearchParams(location.hash.replace(/^#/,"")).get("token");
      if (fragmentToken && /^[a-f0-9]{64}$/.test(fragmentToken)) {
        sessionStorage.setItem(tokenKey,fragmentToken);
        history.replaceState(null,"",location.pathname+location.search);
      }
      const accessToken = sessionStorage.getItem(tokenKey) || "";
      const edgeUrl = `${baseUrl}/functions/v1/board-api`;
      let notes = [];
      let activeFilter = "Alle";
      let editingId = null;
      let toastTimer = null;
      let lastFocused = null;
      let currentlyLoading = false;
      async function ensureIdentity() {
        if(!sb) throw new Error("Supabase-Bibliothek konnte nicht geladen werden.");
        const {data:sessionData,error:sessionError}=await sb.auth.getSession();
        if(sessionError) throw sessionError;
        if(sessionData.session) {
          const {data:userData,error:userError}=await sb.auth.getUser();
          if(!userError && userData.user) {activeUserId=userData.user.id;return sessionData.session.access_token;}
          await sb.auth.signOut();
        }
        const {data,error}=await sb.auth.signInAnonymously();
        if(error || !data.session)throw new Error(error?.message||"Anonyme Anmeldung nicht möglich. Ist Anonymous Auth aktiviert?");
        activeUserId=data.user?.id||null;
        return data.session.access_token;
      }
      async function boardRequest(action,extra={}) {
        if(!/^[a-f0-9]{64}$/.test(accessToken)) throw new Error("Kein gültiger Zugangslink. Bitte den Einladungslink öffnen.");
        if(!sb)throw new Error("Supabase-Bibliothek konnte nicht geladen werden.");
        let authHeader={};
        if(action!=="validate_link"){
          const jwt=await ensureIdentity();
          authHeader={"Authorization":`Bearer ${jwt}`};
        }
        const response=await fetch(edgeUrl,{method:"POST",headers:{
          "Content-Type":"application/json", "apikey":BOARD_CONFIG.supabasePublishableKey,
          "x-board-token":accessToken, ...authHeader
        },body:JSON.stringify({action,...extra}),cache:"no-store"});
        const result=await response.json().catch(()=>({error:"Ungültige Serverantwort"}));
        if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);
        return result;
      }
      function updateAccessUI(){
        $("adminLoginButton").hidden=!sharedMode||!hasAccess||isAdmin;
        $("adminLogoutButton").hidden=!sharedMode||!hasAccess||!isAdmin;
        $("retryMailsButton").hidden=!sharedMode||!hasAccess||!isAdmin;
        $("modeBadge").textContent=!sharedMode?"Demo-Modus":!hasAccess?"Linkzugang prüfen":isAdmin?"Administrator":"Anonym angemeldet";
        for(const id of ["addButton","sidebarAddButton","emptyAddButton"]){$(id).disabled=sharedMode&&!hasAccess;}
      }
      const appMain = $("start");
      const appFooter = document.querySelector("footer");


      $("footerStatus").textContent=sharedMode?"Zugang: Einladungslink + anonyme Identität":"Nicht verbunden";
      $("infoText").textContent=sharedMode?
        "Private Pinnwand: Einladungslink und anonyme Identität erforderlich. Nur der Verfasser oder Administrator darf einen Beitrag ändern.":
        "Lokale Vorschau: Beiträge werden nur in diesem Browser gespeichert.";
      updateAccessUI();
      const demoNotes = () => {
        const now = Date.now();
        return [
          {id:"demo-1",title:"Willkommen auf dem Schwarzen Brett!",content:"Hier kannst du Neuigkeiten teilen, Fragen stellen und Termine ankündigen. Probier es einfach aus – dieser Eintrag ist nur ein Beispiel.",author:"Das Team",category:"Allgemein",color:"yellow",pinned:true,created_at:new Date(now-3600*1000*3).toISOString(),demo:true},
          {id:"demo-2",title:"Nächstes Teamtreffen",content:"Kleine Erinnerung: Unser nächstes Treffen steht an. Weitere Infos kannst du hier als neuen Aushang ergänzen.",author:"Alex",category:"Termine",color:"mint",pinned:false,created_at:new Date(now-3600*1000*16).toISOString(),demo:true},
          {id:"demo-3",title:"Hat jemand einen Tipp?",content:"Du suchst Hilfe, möchtest etwas tauschen oder hast eine kurze Frage? Genau dafür ist diese Pinnwand da.",author:"Sam",category:"Fragen",color:"lavender",pinned:false,created_at:new Date(now-3600*1000*28).toISOString(),demo:true}
        ];
      };
      function localGet(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } }
      function localSet(key, val) { try { window.localStorage.setItem(key,val); return true; } catch (_) { return false; } }
      function loadLocal() { markUpdated("Lokal"); const raw=localGet(storageKey); if (raw===null) {notes=demoNotes();localSet(storageKey,JSON.stringify(notes));} else {try {const parsed=JSON.parse(raw); notes=Array.isArray(parsed)?parsed:[];} catch (_) {notes=[];}} render(); }
      function persistLocal() { if (!localSet(storageKey,JSON.stringify(notes))) { showToast("Der Browser erlaubt keine dauerhafte Speicherung.",true); } }
      const safeText = (v) => typeof v === "string" ? v : "";
      function showToast(message,error=false) { const t=$("toast");t.textContent=message;t.className=`toast${error?" error":""}`;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,4200); }
      function formatDate(value) {const dt=new Date(value);if(Number.isNaN(dt.getTime()))return "Unbekannt";return new Intl.DateTimeFormat("de-DE",{day:"2-digit",month:"short",year:"numeric"}).format(dt);}
      function addEl(tag,cls,text) { const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el; }
      function appendIcon(button,kind) {
        const icons={delete:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg>',edit:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/></svg>'};button.innerHTML=icons[kind];
      }
      function imageIsSafe(raw){
        if(typeof raw!=="string"||!raw)return false;
        try {const u=new URL(raw);return u.protocol==="https:"&&u.origin===new URL(baseUrl).origin&&u.pathname.startsWith("/storage/v1/object/sign/board-images/");}
        catch{return false;}
      }
      function card(note,i) {
        const item=addEl("article","note");
        item.dataset.color=allowedColors.includes(note.color)?note.color:"yellow";
        const top=addEl("div","thread-strip");
        const left=addEl("div","thread-strip-left");
        left.append(addEl("span","thread-ico",note.pinned?"★":"▸"));
        left.append(addEl("span","category",allowedCategories.includes(note.category)?note.category:"Allgemein"));
        left.append(addEl("span","thread-index",`THREAD ${String(i+1).padStart(3,"0")}`));
        top.append(left);
        if(note.pinned)top.append(addEl("span","important","★ ANGEPINNT"));
        else if(note.demo)top.append(addEl("span","important","DEMO"));
        item.append(top);
        const inner=addEl("div","thread-inner");
        const by=addEl("aside","thread-user");
        const author=safeText(note.author)||"Anonym";
        const avatar=addEl("span","avatar",author.trim().slice(0,1).toLocaleUpperCase("de-DE")||"?");
        if(sharedMode && imageIsSafe(note.avatar_url)){
          avatar.textContent="";const img=addEl("img");img.src=note.avatar_url;img.alt="Individuelles Profilbild";img.loading="lazy";avatar.append(img);
        }
        by.append(avatar);
        by.append(addEl("span","note-author",author));
        by.append(addEl("span","user-rank","BOARD MEMBER"));
        const bars=addEl("span","rank-pips");
        for(let j=0;j<3;j++)bars.append(addEl("i"));
        bars.setAttribute("aria-hidden","true");by.append(bars);inner.append(by);
        const message=addEl("div","thread-message");
        message.append(addEl("h3",null,safeText(note.title)));
        message.append(addEl("p",null,safeText(note.content)));
        if(Array.isArray(note.image_urls) && note.image_urls.length){
          const gallery=addEl("div","note-gallery");
          for(const url of note.image_urls){
            if(!imageIsSafe(url))continue;
            const link=addEl("a");link.href=url;link.target="_blank";link.rel="noopener noreferrer";
            const img=addEl("img");img.src=url;img.loading="lazy";img.alt=`Bild zum Beitrag ${safeText(note.title)}`;
            link.append(img);gallery.append(link);
          }
          message.append(gallery);
        }
        const footer=addEl("div","note-footer");
        footer.append(addEl("span","note-date",`GESCHRIEBEN: ${formatDate(note.created_at)} · #${String(i+1).padStart(3,"0")}`));
        if(!sharedMode || note.can_edit===true){
          const actions=addEl("div","note-actions");
          const edit=addEl("button",null,"[ EDIT ]");edit.type="button";edit.title="Nachricht bearbeiten";edit.setAttribute("aria-label",`${safeText(note.title)} bearbeiten`);edit.addEventListener("click",()=>openModal(note.id));actions.append(edit);
          const del=addEl("button",null,"[ X LÖSCHEN ]");del.type="button";del.title="Nachricht löschen";del.setAttribute("aria-label",`${safeText(note.title)} löschen`);del.addEventListener("click",()=>removeNote(note.id));actions.append(del);
          footer.append(actions);
        }
        const votes=addEl("div","vote-box");
        const up=addEl("button",null,"▲ GUT");up.type="button";
        const down=addEl("button",null,"▼ NICHT GUT");down.type="button";
        const score=addEl("span","score",`SCORE: ${ratings.get(note.id) ?? 0}`);
        up.addEventListener("click",()=>rateNote(note.id,1,up,down));
        down.addEventListener("click",()=>rateNote(note.id,-1,up,down));
        votes.append(up,score,down);message.append(votes);
        message.append(footer);inner.append(message);item.append(inner);return item;
      }
      async function rateNote(id,value,up,down){
        up.disabled=down.disabled=true;
        try{
          if(sharedMode){const result=await boardRequest("rate",{id,value});ratings.set(id,result.score);}
          else {const key=`vote-${id}-${voterId}`;const old=Number(localStorage.getItem(key)||0);localStorage.setItem(key,String(value));ratings.set(id,(ratings.get(id)||0)-old+value);}
          render();showToast("Bewertung gespeichert.");
        }catch(e){showToast(`Bewertung fehlgeschlagen: ${e.message}`,true);up.disabled=down.disabled=false;}
      }
      function render() {
        const search=$("searchInput").value.trim().toLocaleLowerCase("de-DE");
        let filtered=notes.filter(n=>(activeFilter==="Alle"||n.category===activeFilter)&&(!search||[n.title,n.content,n.author,n.category].some(v=>safeText(v).toLocaleLowerCase("de-DE").includes(search))));
        const ordering=$("sortSelect").value;
        filtered.sort((a,b)=>{if(ordering==="important"&&Boolean(a.pinned)!==Boolean(b.pinned))return Number(Boolean(b.pinned))-Number(Boolean(a.pinned));const difference=new Date(b.created_at).getTime()-new Date(a.created_at).getTime();return ordering==="oldest"?-difference:difference;});
        const container=$("notesContainer");container.replaceChildren();const fragment=document.createDocumentFragment();filtered.forEach((n,i)=>fragment.append(card(n,i)));container.append(fragment);
        $("totalCount").textContent=String(notes.length);
        $("resultCount").textContent=`${filtered.length} ${filtered.length===1?"Nachricht":"Nachrichten"}`;
        $("boardTitle").textContent=activeFilter==="Alle"?"Alle Aushänge":activeFilter;
        const empty=filtered.length===0;$("emptyState").hidden=!empty;$("notesContainer").hidden=empty;
        $("emptyMessage").textContent=notes.length===0?"Eröffne die erste Diskussion im Board.":"Hier wurden noch keine passenden Beiträge gefunden.";
      }
      function markUpdated(label) {
        $("connectionLabel").textContent=label;
        $("lastSyncTime").textContent=new Intl.DateTimeFormat("de-DE",{hour:"2-digit",minute:"2-digit"}).format(new Date());
      }
      function setLoading(loading) { currentlyLoading=loading;$("refreshButton").disabled=loading; }
      async function loadRemote(silent=false) {
        if(currentlyLoading)return;
        setLoading(true);
        try {
          const result=await boardRequest("list");
          notes=result.notes||[];isAdmin=result.is_admin===true;updateAccessUI();ratings.clear();for(const r of result.ratings||[])ratings.set(r.note_id,Number(r.score)||0);
          markUpdated("Online");render();
          if(!silent)showToast("Pinnwand ist auf dem neuesten Stand.");
          $("infoBar").classList.add("online");
          $("infoText").textContent="Privates Board: Einladungslink und individuelle anonyme Identität. Bearbeiten/Löschen nur für Verfasser oder Administrator. Abgleich alle 20 Sekunden.";
        } catch(error) {
          if(!silent||notes.length===0)showToast(`Abruf fehlgeschlagen: ${error.message}`,true);
          $("infoBar").classList.remove("online");
          $("infoText").textContent=`Zugriff fehlgeschlagen: ${error.message}`;
          $("connectionLabel").textContent="Gesperrt";
        } finally {setLoading(false);}
      }
      async function addRemote(record) {const r=await boardRequest("add",{record});if(!r.id)throw new Error("Beitrags-ID fehlt");return r.id;}
      async function updateRemote(id,record) {const r=await boardRequest("update",{id,record});if(!r.ok)throw new Error("Beitrag nicht gefunden");}
      async function removeNote(id) {
        const note=notes.find(n=>n.id===id);
        if(!note)return;
        if(sharedMode && note.can_edit!==true){showToast("Bearbeitung nicht erlaubt.",true);return;}
        if(!confirm(`Aushang „${safeText(note.title)}“ wirklich löschen?`))return;
        if(sharedMode) {
          try {
            const result=await boardRequest("delete",{id});
            if(!result.ok)throw new Error("Beitrag nicht gefunden.");
            await loadRemote(true);
            showToast("Aushang wurde entfernt.");
          } catch(error) {showToast(`Löschen fehlgeschlagen: ${error.message}`,true);}
        } else {
          notes=notes.filter(n=>n.id!==id);
          persistLocal();render();showToast("Aushang wurde entfernt.");
        }
      }
      function updateCounters() {$("titleCounter").textContent=`${$("noteTitle").value.length}/80`;$("contentCounter").textContent=`${$("noteContent").value.length}/1200`;}
      function previewExisting(note){
        const gallery=$("existingImages"),avatar=$("existingAvatar");gallery.replaceChildren();avatar.replaceChildren();
        if(!note||!sharedMode)return;
        (note.image_paths||[]).forEach((path,i)=>{
          if(removedImagePaths.has(path))return;
          const card=addEl("div","media-thumb");
          if(imageIsSafe(note.image_urls?.[i])){const img=addEl("img");img.src=note.image_urls[i];img.alt="Gespeichertes Bild";card.append(img);}
          const del=addEl("button",null,"Entfernen");del.type="button";
          del.addEventListener("click",()=>{removedImagePaths.add(path);previewExisting(note);});
          card.append(del);gallery.append(card);
        });
        if(note.avatar_url&&!removeAvatarPending&&imageIsSafe(note.avatar_url)){
          const card=addEl("div","media-thumb"),img=addEl("img");img.src=note.avatar_url;img.alt="Profilbild";
          const del=addEl("button",null,"Profilbild entfernen");del.type="button";
          del.addEventListener("click",()=>{removeAvatarPending=true;previewExisting(note);});
          card.append(img,del);avatar.append(card);
        }
      }
      function toggleAnonymous(){
        const yes=$("postAnonymous").checked;
        $("noteAuthor").disabled=yes;
        if(yes){$("noteAuthor").value="Anonym";}
        else if($("noteAuthor").value==="Anonym"){$("noteAuthor").value=localGet(nameKey)||"";}
      }
      function openModal(id=null) {
        if(sharedMode&&!hasAccess){showToast("Bitte öffne zuerst einen gültigen Einladungslink.",true);return;}
        const note=id===null?null:notes.find(n=>n.id===id);
        if(note&&sharedMode&&note.can_edit!==true){showToast("Keine Berechtigung zum Bearbeiten.",true);return;}
        editingId=id;lastFocused=document.activeElement;
        removedImagePaths=new Set();removeAvatarPending=false;
        $("noteForm").reset();
        $("modalHeading").textContent=note?"Beitrag bearbeiten":"Neuen Beitrag posten";
        $("saveButton").textContent=note?"ÄNDERUNGEN SPEICHERN »":"BEITRAG ABSCHICKEN »";
        $("noteTitle").value=note?safeText(note.title):"";
        $("noteContent").value=note?safeText(note.content):"";
        $("noteAuthor").value=note?safeText(note.author):(localGet(nameKey)||"");
        $("postAnonymous").checked=$("noteAuthor").value==="Anonym";
        toggleAnonymous();
        $("noteCategory").value=note&&allowedCategories.includes(note.category)?note.category:"Allgemein";
        $("noteImportant").checked=Boolean(note?.pinned);
        const color=note&&allowedColors.includes(note.color)?note.color:"yellow";
        const radio=document.querySelector(`input[name="color"][value="${color}"]`);if(radio)radio.checked=true;
        previewExisting(note);updateCounters();
        $("modalBackdrop").hidden=false;document.body.style.overflow="hidden";$("noteTitle").focus();
      }
      function closeModal(){
        $("modalBackdrop").hidden=true;document.body.style.overflow="";editingId=null;
        $("existingImages").replaceChildren();$("existingAvatar").replaceChildren();
        if(lastFocused?.focus)lastFocused.focus();
      }
      async function prepareImage(file,isAvatar){
        if(!["image/jpeg","image/png","image/webp"].includes(file.type))throw Error("Nur JPEG, PNG und WebP sind erlaubt.");
        if(file.size>12_000_000)throw Error("Originalbild ist zu groß (maximal 12 MB).");
        const source=await createImageBitmap(file);
        try{
          const cv=document.createElement("canvas"),ctx=cv.getContext("2d");
          if(!ctx)throw Error("Bildverarbeitung ist nicht verfügbar.");
          if(isAvatar){
            const side=Math.min(source.width,source.height),x=(source.width-side)/2,y=(source.height-side)/2;
            cv.width=cv.height=256;ctx.drawImage(source,x,y,side,side,0,0,256,256);
          }else{
            const scale=Math.min(1,1280/Math.max(source.width,source.height));
            cv.width=Math.max(1,Math.round(source.width*scale));cv.height=Math.max(1,Math.round(source.height*scale));
            ctx.drawImage(source,0,0,cv.width,cv.height);
          }
          let blob=await new Promise(resolve=>cv.toBlob(resolve,"image/webp",0.78));
          if(!blob||blob.type!=="image/webp")blob=await new Promise(resolve=>cv.toBlob(resolve,"image/jpeg",0.78));
          if(!blob||blob.size>1_500_000)throw Error("Das komprimierte Bild ist größer als 1,5 MB.");
          const dataUrl=await new Promise((resolve,reject)=>{
            const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error("Bild konnte nicht gelesen werden."));reader.readAsDataURL(blob);
          });
          return dataUrl;
        }finally{source.close();}
      }
      async function handleSubmit(event) {
        event.preventDefault();if(!$("noteForm").reportValidity())return;
        const title=$("noteTitle").value.trim(),content=$("noteContent").value.trim();
        const author=$("postAnonymous").checked?"Anonym":$("noteAuthor").value.trim();
        const category=$("noteCategory").value;
        const color=document.querySelector('input[name="color"]:checked')?.value||"yellow";
        if(title.length<2||content.length<2||author.length<1){showToast("Bitte fülle alle Pflichtfelder aus.",true);return;}
        const record={title,content,author,category:allowedCategories.includes(category)?category:"Allgemein",color:allowedColors.includes(color)?color:"yellow",pinned:$("noteImportant").checked};
        const picked=[...$("noteImages").files],avatarFile=$("noteAvatar").files[0]||null;
        const before=editingId!==null?notes.find(n=>n.id===editingId):null;
        if(picked.length+(before?.image_paths||[]).filter(path=>!removedImagePaths.has(path)).length>3){showToast("Maximal drei Bilder pro Beitrag. Bitte vorhandene Bilder entfernen.",true);return;}
        if(!sharedMode&&(picked.length||avatarFile)){showToast("Bilder sind nur im verbundenen Board verfügbar.",true);return;}
        $("saveButton").disabled=true;
        if(!$("postAnonymous").checked)localSet(nameKey,author);
        let saved=false;
        try{
          const prepared=[];
          for(const file of picked)prepared.push(await prepareImage(file,false));
          const newAvatar=avatarFile?await prepareImage(avatarFile,true):null;
          if(sharedMode){
            const id=editingId!==null?editingId:await addRemote(record);
            if(editingId!==null)await updateRemote(id,record);
            saved=true;
            for(const path of removedImagePaths)await boardRequest("remove_image",{id,path});
            if(removeAvatarPending)await boardRequest("remove_avatar",{id});
            for(const dataUrl of prepared)await boardRequest("upload_image",{id,kind:"image",dataUrl});
            if(newAvatar)await boardRequest("upload_image",{id,kind:"avatar",dataUrl:newAvatar});
            await loadRemote(true);
            showToast(editingId!==null?"Beitrag aktualisiert.":"Beitrag veröffentlicht. E-Mail-Benachrichtigungen werden serverseitig verarbeitet.");
          }else if(editingId!==null){notes=notes.map(n=>n.id===editingId?{...n,...record,demo:false}:n);persistLocal();render();showToast("Aushang aktualisiert.");}
          else {const id=crypto.randomUUID();notes.unshift({...record,id,created_at:new Date().toISOString(),demo:false});persistLocal();render();showToast("Nachricht erfolgreich veröffentlicht.");}
          closeModal();
        }catch(error){
          if(saved){await loadRemote(true);closeModal();showToast(`Text gespeichert, aber Bildaktion fehlgeschlagen: ${error.message}`,true);}
          else showToast(`Speichern fehlgeschlagen: ${error.message}`,true);
        }finally{$("saveButton").disabled=false;}
      }
      document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>{activeFilter=btn.dataset.filter;document.querySelectorAll(".tab").forEach(other=>{const active=other===btn;other.classList.toggle("active",active);other.setAttribute("aria-pressed",active?"true":"false");});render();}));
      document.querySelectorAll(".quick-filter").forEach(btn=>btn.addEventListener("click",()=>{
        const filter=btn.dataset.quickFilter;
        const tab=Array.from(document.querySelectorAll(".tab")).find(el=>el.dataset.filter===filter);
        if(tab)tab.click();
        $("forum").scrollIntoView({behavior:"smooth",block:"start"});
      }));
      $("sidebarAddButton").addEventListener("click",()=>openModal());
      $("searchInput").addEventListener("input",render);$("sortSelect").addEventListener("change",render);
      ["addButton","emptyAddButton"].forEach(id=>$(id).addEventListener("click",()=>openModal()));
      // Der Beitragsdialog schließt nur per X oder nach erfolgreichem Speichern.
      $("closeModal").addEventListener("click",closeModal);
      $("noteTitle").addEventListener("input",updateCounters);$("noteContent").addEventListener("input",updateCounters);$("noteForm").addEventListener("submit",handleSubmit);
      $("refreshButton").addEventListener("click",()=>sharedMode?loadRemote():showToast("Alle lokalen Nachrichten werden bereits angezeigt."));
      $("postAnonymous").addEventListener("change",toggleAnonymous);
      $("helpButton").addEventListener("click",()=>alert(sharedMode?
        "Nur mit gültigem Einladungslink und anonymer Supabase-Identität. Bearbeiten/Löschen nur durch Verfasser oder Administrator. Die Browseridentität geht verloren, wenn du die lokalen Auth-Daten löschst oder dich abmeldest. Ein Profilbild kann dich erkennbar machen.":
        "Lokale Demo: Nachrichten bleiben in diesem Browser. Für die gemeinsame Nutzung Supabase nach der Anleitung einrichten."));
      $("adminLoginButton").addEventListener("click",()=>{$("adminBackdrop").hidden=false;$("adminEmail").focus();});
      function closeAdmin(){$("adminBackdrop").hidden=true;$("adminPassword").value="";}
      $("adminClose").addEventListener("click",closeAdmin);
      $("adminBackdrop").addEventListener("click",e=>{if(e.target===$("adminBackdrop"))closeAdmin();});
      $("adminForm").addEventListener("submit",async e=>{
        e.preventDefault();if(!hasAccess||!sb)return;
        $("adminSubmit").disabled=true;
        try{
          const {error}=await sb.auth.signInWithPassword({email:$("adminEmail").value.trim(),password:$("adminPassword").value});
          if(error)throw error;
          const r=await boardRequest("list");
          if(r.is_admin!==true){await sb.auth.signOut();throw Error("Dieses Benutzerkonto ist nicht als Board-Admin freigeschaltet.");}
          isAdmin=true;closeAdmin();await loadRemote(true);showToast("Administrator angemeldet.");
        }catch(error){showToast(`Admin-Anmeldung: ${error.message}`,true);}
        finally{$("adminSubmit").disabled=false;}
      });
      $("adminLogoutButton").addEventListener("click",async()=>{
        if(!confirm("Admin abmelden? Danach wird eine neue anonyme Identität erstellt."))return;
        try{await sb.auth.signOut();activeUserId=null;isAdmin=false;await ensureIdentity();await loadRemote(true);showToast("Admin abgemeldet; neue anonyme Sitzung aktiv.");}
        catch(error){showToast(`Abmelden fehlgeschlagen: ${error.message}`,true);}
      });
      $("retryMailsButton").addEventListener("click",async()=>{
        try{const r=await boardRequest("retry_notifications");const n=r.notification||{};
          showToast(n.configured===false?"E-Mail-Konfiguration (Resend) fehlt.":`Versandversuch: ${n.sent||0} E-Mails, ${n.failed||0} fehlgeschlagen.`);
        }catch(error){showToast(`E-Mailversand: ${error.message}`,true);}
      });
      if(sharedMode) {
        (async()=>{
          try{
            await boardRequest("validate_link"); // Kein anonymer Auth-Account bei falschem Link anlegen.
            hasAccess=true;updateAccessUI();
            await ensureIdentity();
            await loadRemote(true);
          }catch(error){
            hasAccess=false;updateAccessUI();
            $("infoText").textContent=`Zugriff fehlgeschlagen: ${error.message}`;
            $("connectionLabel").textContent="Gesperrt";
            showToast(`Verbindung fehlgeschlagen: ${error.message}`,true);
          }
        })();
        setInterval(()=>{if(hasAccess&&document.visibilityState==="visible"&&$("modalBackdrop").hidden)loadRemote(true);},20000);
      }else{loadLocal();$("connectionLabel").textContent="Demo";}
    })();
