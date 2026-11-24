import { useId, useMemo, useState } from 'react';

export interface Choice {
  id: string;
  label: string;
  /// Ce qui distingue deux choix de meme nom : la nature d'un asset, un
  /// scenario face a un pion.
  hint?: string;
}

interface AutocompleteProps {
  choices: Choice[];
  onPick: (choice: Choice) => void;
  placeholder: string;
  disabled?: boolean;
}

/// Combien de suggestions a la fois : au-dela, on affine sa recherche plutot
/// que de faire defiler une liste qui redevient celle qu'on voulait eviter.
const SHOWN = 8;

/// Sans accents ni majuscules : « cthulhu » doit trouver « Cthulhu », et
/// « kerloch » « Kerloc'h ».
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/// Un champ ou l'on tape quelques lettres pour choisir parmi un catalogue qui
/// ne tient plus dans une liste. Choisir vide le champ : on enchaine les ajouts
/// sans rien effacer.
export function Autocomplete({ choices, onPick, placeholder, disabled }: AutocompleteProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const matches = useMemo(() => {
    const words = fold(query).split(' ').filter(Boolean);
    const found =
      words.length === 0
        ? choices
        : choices.filter((choice) => {
            const text = fold(`${choice.label} ${choice.hint ?? ''}`);
            return words.every((word) => text.includes(word));
          });
    return found.slice(0, SHOWN);
  }, [choices, query]);

  const pick = (choice: Choice) => {
    onPick(choice);
    setQuery('');
    setActive(0);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const choice = matches[active];
      if (open && choice) {
        event.preventDefault();
        pick(choice);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="autocomplete">
      <input
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Apres le clic sur une suggestion : `onMouseDown` la choisit avant
        // que la perte du focus ne ferme la liste.
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="suggestions" id={listId} role="listbox">
          {matches.length === 0 ? (
            <li className="empty">Aucun résultat.</li>
          ) : (
            matches.map((choice, index) => (
              <li
                key={choice.id}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'active' : undefined}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(choice);
                }}
              >
                <span>{choice.label}</span>
                {choice.hint && <span className="kind">{choice.hint}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
