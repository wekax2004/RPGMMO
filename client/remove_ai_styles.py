import re

css_path = 'c:\\Users\\home\\.gemini\\antigravity\\scratch\\tibia_mmo\\client\\css\\style.css'
html_path = 'c:\\Users\\home\\.gemini\\antigravity\\scratch\\tibia_mmo\\client\\test_client.html'

def clean_css(content):
    # Remove border-radius
    content = re.sub(r'border-radius:\s*[^;]+;', 'border-radius: 0;', content)
    # Replace Outfit and Inter with VT323
    content = re.sub(r'\'Outfit\',\s*sans-serif', "'VT323', monospace", content)
    content = re.sub(r'\'Inter\',\s*sans-serif', "'VT323', monospace", content)
    # Simplify box-shadows to solid colors (or remove them)
    content = re.sub(r'box-shadow:\s*[^;]+;', 'box-shadow: none;', content)
    # Replace linear gradients with solid #444
    content = re.sub(r'background:\s*linear-gradient\([^;]+\);', 'background: #444;', content)
    return content

# Update CSS
with open(css_path, 'r', encoding='utf-8') as f:
    css_content = f.read()
css_content = clean_css(css_content)
with open(css_path, 'w', encoding='utf-8') as f:
    f.write(css_content)

# Update HTML
with open(html_path, 'r', encoding='utf-8') as f:
    html_content = f.read()
html_content = clean_css(html_content)
with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html_content)

print("Cleaned up AI styles from CSS and HTML!")
