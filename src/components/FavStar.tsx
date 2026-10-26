// 관심 협력사·부품 고정 (별 아이콘) — 사용자별로 이 브라우저에 저장
import { LuStar } from "react-icons/lu";
import { useStore } from "../store/store";

export function FavStar({ kind, id, name, size = "sm" }: { kind: "suppliers" | "items"; id: string; name: string; size?: "sm" | "md" }) {
  const { state, dispatch } = useStore();
  const on = state.favorites[kind].includes(id);
  const what = kind === "suppliers" ? "관심 협력사" : "관심 부품";
  return (
    <button
      type="button"
      className={`fav-star fav-${size} ${on ? "is-on" : ""}`}
      aria-pressed={on}
      aria-label={on ? `${name} ${what}에서 빼기` : `${name} ${what}로 고정`}
      title={on ? `${what}에서 빼기` : `${what}로 고정`}
      onClick={(e) => {
        e.stopPropagation();
        dispatch({ type: "toggleFav", kind, id });
        dispatch({ type: "toast", text: on ? `'${name}'을(를) ${what}에서 뺐습니다` : `'${name}'을(를) ${what}로 고정했습니다` });
      }}
    >
      <LuStar aria-hidden />
    </button>
  );
}
