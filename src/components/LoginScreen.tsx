// 간이 로그인 (시연용): 이름·사번(또는 부서)만 받는다. 비밀번호를 받지 않으며 보안 인증이 아니다.
import { useRef, useState, type FormEvent } from "react";
import { LuArrowRight, LuPlay, LuShieldAlert, LuUserRound } from "react-icons/lu";
import { BrandBlock } from "./Brand";
import { demoLogin, listUsers, login, switchTo, type User } from "../platform/users";

export function LoginScreen({ onLogin }: { onLogin: (u: User) => void }) {
  const [name, setName] = useState("");
  const [dept, setDept] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const recent = listUsers().slice(0, 4);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErr("이름을 입력해 주세요. 비밀번호 없이 이름만 있으면 들어갈 수 있습니다.");
      nameRef.current?.focus();
      return;
    }
    onLogin(login(name, dept));
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-brand">
          <BrandBlock as="div" />
        </div>
        <h1 className="login-title">시작하기</h1>
        <p className="login-lead">협력사·구매조달·원가·자재 데이터를 한 화면에서 보고, AI에게 질문해 분석 결과를 받습니다.</p>
        <form className="login-form" onSubmit={submit} noValidate>
          <label className="field">
            <span>
              이름 <b className="req">필수</b>
            </span>
            <input ref={nameRef} id="login-name" type="text" autoComplete="name" value={name} onChange={(e) => (setName(e.target.value), setErr(null))} placeholder="예: 홍길동" maxLength={20} aria-invalid={!!err} aria-describedby={err ? "login-err" : undefined} autoFocus />
            {err && (
              <span className="note-bad" id="login-err" role="alert">
                {err}
              </span>
            )}
          </label>
          <label className="field">
            <span>
              사번 또는 부서 <small>선택</small>
            </span>
            <input id="login-dept" type="text" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="예: 구매팀" maxLength={20} />
          </label>
          <button type="submit" className="btn btn-primary btn-lg" id="login-submit">
            들어가기 <LuArrowRight aria-hidden />
          </button>
        </form>
        <div className="login-or">
          <span>또는</span>
        </div>
        <button type="button" className="btn btn-quiet btn-lg login-demo" id="login-demo" onClick={() => onLogin(demoLogin())}>
          <LuPlay aria-hidden /> 시연 계정으로 바로 시작
        </button>
        {recent.length > 0 && (
          <div className="login-recent">
            <p>이 브라우저에서 쓴 사용자</p>
            <div className="login-recent-list">
              {recent.map((u) => (
                <button key={u.id} type="button" className="chip-btn" onClick={() => onLogin(switchTo(u.id) ?? u)}>
                  <LuUserRound aria-hidden /> {u.name}
                  {u.dept ? ` · ${u.dept}` : ""}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="login-note">
          <LuShieldAlert aria-hidden />
          <span>
            시연용 간이 로그인입니다. 이 브라우저에만 저장되며 보안 인증이 아닙니다. 비밀번호를 받지 않으니 실제 계정 정보를 넣지 마세요. 화면의 업체·수치는 모두 SAMPLE(가상) 데이터입니다.
          </span>
        </p>
      </div>
    </div>
  );
}
