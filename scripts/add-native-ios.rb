# Adds an app's own Swift files to the generated Capacitor iOS project.
# Called by scripts/prepare-app.mjs when game.json has "native": { "ios": { "swift": [...] } }.
#
#   bundle exec ruby scripts/add-native-ios.rb <path/to/App.xcodeproj> <file.swift> [...]
#
# The files must already be copied into ios/App/App/. They are added to the "App"
# group and compiled into the "App" target.
require "xcodeproj"

project_path = ARGV.shift or abort("usage: add-native-ios.rb App.xcodeproj file.swift ...")
files = ARGV
abort("no Swift files given") if files.empty?

project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |t| t.name == "App" } or abort("No App target in #{project_path}")
group = project.main_group.children.find { |g| g.respond_to?(:display_name) && g.display_name == "App" } || project.main_group

files.each do |name|
  base = File.basename(name)
  if group.files.any? { |f| f.path == base }
    puts "  already in project: #{base}"
    next
  end
  ref = group.new_reference(base)
  target.add_file_references([ref])
  puts "  added #{base} to target App"
end

project.save
