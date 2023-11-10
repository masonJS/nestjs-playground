#!/bin/sh

success() {
  echo ""
  echo "### $@ ###"
  echo ""
}

usage() {
  echo "사용법: [-M | -m | -p]"
  exit 1
}

failure() {
  echo "$@"
  exit 1
}

while getopts "Mmp" option; do
  case $option in
  M) major=true ;;
  m) minor=true ;;
  p) patch=true ;;
  esac
done

if [ -z "$major" ] && [ -z "$minor" ] && [ -z "$patch" ]; then
  usage
fi

success "가장 최근 버전을 확인합니다."
git fetch root --tags || failure "태그 목록을 가져오지 못했습니다."
currentVersion=$(git describe --tags $(git rev-list --tags --max-count=1))

semver=(${currentVersion//./ })

if [ ${#semver[@]} -ne 3 ]; then
  failure "현재버전이 유효하지 않습니다: $currentVersion"
fi

success "현재 버전: $currentVersion"

if [ -n "$major" ]; then
  ((semver[0]++))
  semver[1]=0
  semver[2]=0
fi

if [ -n "$minor"]; then
  ((semver[1]++))
  semver[2]=0
fi

if [ -n "$patch"]; then
  ((semver[2]++))
fi

newVersion="${semver[0]}.${semver[1]}.${semver[2]}"

success "다음 버전: $newVersion"

success "release 브랜치를 생성합니다."
git switch develop || failure "develop 브랜치로 전환하지 못했습니다."
git pull || failure "git pull 실행을 하지 못했습니다."
git switch -c release/$newVersion  || failure "release 브랜치를 생성하지 못했습니다."

success "main 브랜치와 리베이스합니다."
git rebase root/main || failure "리베이스를 실패하였습니다."

success "release 브랜치를 push합니다."
git push --set-upstream root release/$newVersion || failure "release 브랜치를 푸시하지 못했습니다."

success "release PR을 생성합니다."

isGhInstalled=$(which gh)
if [ -n "$isGhInstalled" ]; then
  files=$(git diff root/main..root/release/1.1.0 --name-only | grep -E "^scripts/migration/.*\.ts$")
  if [ -n "$files" ]; then
    gh pr create --web --title "Release $newVersion" --assignee "@me" --body "## ✅변경된 DDL 파일들이 존재합니다 ### 운영 DB에 해당 수정사항을 반영했는지 확인해주세요! "
  else
    gh pr create --web --title "Release $newVersion" --assignee "@me"
  fi
else
  failure "gh cli가 설치되어 있지 않습니다."
fi


success "PR 생성 URL: https://github.com/masonJS/nestjs-playground/compare/main...release/$newVersion"
