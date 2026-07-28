# Ofa Karri

## Description du projet
Ofa Karri est une marque qui vend des sprays, roll-on et huiles corporelles en ligne, à la fois en B2C et en B2B.

Ce dépôt regroupe les scripts et outils d'automatisation des processus de l'entreprise (marketing, communication, e-commerce, opérations). Il est amené à grossir au fil du temps avec de nouveaux modules d'automatisation.

Modules actuels :
- Synchronisation comptable (facturation)
- Suivi des commandes/livraisons

## Convention pour les futurs modules

Chaque nouvel automatisme (marketing, CRM, stock, reporting, etc.) devrait suivre la même logique que les modules existants :
- Un dossier dédié à la racine, nommé clairement (`nom_fonction_sync` ou équivalent)
- Un `README.md` ou `SETUP.md` propre au module s'il nécessite une configuration
- Aucun identifiant/clé API en clair dans le code — toujours dans un fichier exclu du `.gitignore`
- Une brève description ajoutée dans la section ci-dessus pour que ce fichier reste à jour

## Stack technique

- **Langage** : Google Apps Script (JavaScript côté Google)
- **Outil de déploiement** : [clasp](https://github.com/google/clasp) (CLI officielle de Google pour Apps Script)
- **Base de données** : aucune — les scripts lisent/écrivent directement dans Google Sheets et/ou appellent des API externes
- **Déploiement** : Google Apps Script (pas de Vercel pour l'instant)

## Modules du projet

### `toconline_sync/`
Synchronisation avec **TocOnline** (facturation/comptabilité).
- `Code.gs` — logique principale du script
- `appsscript.json` — configuration du projet Apps Script
- `.clasp.json` — identifiant du projet Apps Script lié (non sensible, juste un ID)
- `creds.json` — **ne doit jamais être commité** (contient les identifiants OAuth Google), déjà exclu via `.gitignore`
- `SETUP.md` — instructions d'installation/configuration du module

### `tracking_sync/`
Suivi des commandes / livraisons.
- `Code.gs` — logique principale du script

## Commandes utiles (clasp)

```bash
clasp login              # Se connecter à son compte Google (une fois par machine)
clasp pull                # Récupérer la dernière version depuis Google Apps Script
clasp push                 # Envoyer les modifications locales vers Google Apps Script
clasp open                  # Ouvrir le projet dans l'éditeur Apps Script en ligne
```

[À compléter si vous utilisez d'autres commandes spécifiques au projet]

## Conventions de code

- **Nommage** : camelCase pour les variables et fonctions
- **Commits** : format `type: description courte`
  - Exemples : `feat: ajout sync factures TocOnline`, `fix: correction format date tracking`
  - Types acceptés : `feat`, `fix`, `refactor`, `docs`, `chore`
- **Branches** : `type/description-courte` (ex: `feat/sync-factures`)
- **Pull requests recommandées** avant de merger sur `main`, même à deux, pour se relire mutuellement

## Zones sensibles — ne jamais toucher sans validation explicite

- [ ] `toconline_sync/creds.json` — contient les identifiants OAuth Google (Client ID/Secret). Ne jamais committer. Si régénéré, mettre à jour uniquement en local.
- [ ] Toute logique touchant à la facturation ou aux montants envoyés à TocOnline
- [ ] Configuration `.clasp.json` — lie le code local au bon projet Apps Script en ligne, à ne pas modifier sans savoir ce que ça implique

## Secrets et identifiants

- Les identifiants Google OAuth (`creds.json`) sont exclus du dépôt via `.gitignore`
- **Incident passé** : ce fichier a été commité par erreur une première fois (identifiants Google OAuth exposés localement avant d'être retirés de l'historique). Les identifiants concernés devraient être régénérés dans la console Google Cloud par précaution.
- Ne jamais partager `creds.json` par message ou email — utiliser un gestionnaire de mots de passe partagé si besoin de le transmettre à l'associé

## Processus de collaboration

1. Créer une branche depuis `main` pour toute modification
2. Développer et tester localement (`clasp push` vers un projet de test si possible)
3. Ouvrir une pull request sur GitHub
4. Relecture par l'autre associé avant merge
5. Merge dans `main`, puis `clasp push` vers le projet Apps Script de production

## Notes pour Claude Code

- Toujours vérifier qu'un fichier ne contient pas de secrets avant un `git add` ou un commit
- Ne jamais exécuter `git push` sans confirmation explicite
- Proposer des changements par petites unités logiques (un module à la fois)
- En cas de doute sur une convention non documentée ici, demander plutôt que de deviner
